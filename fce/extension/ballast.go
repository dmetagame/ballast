// Package extension implements the Ballast confidential trigger as a Flare Compute Extension.
//
// The point of running this inside a TEE is narrow and worth stating precisely: it keeps the
// borrower's liquidation trigger out of public storage. Everything else about Ballast already
// works on-chain. What leaks in v1 is *when* a borrower wants to be protected, and that is
// exactly what a searcher needs to aim at them.
//
// Nothing in here is trusted with authority. The verdict this extension signs is clamped
// on-chain by BallastManagerV2 against bounds the borrower set themselves, so a compromised
// enclave can at worst do something already authorised.
package extension

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"time"

	"ballast-fce/config"
	"ballast-fce/types"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	"github.com/flare-foundation/tee-node/pkg/processorutils"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
)

// wad is 1e18, the fixed-point scale health factors are expressed in.
var wad = new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)

// secretKey identifies one protected position.
type secretKey struct {
	borrower common.Address
	market   common.Hash
}

// Extension holds the enclave's confidential state.
//
// `secrets` is the whole reason this process exists. It is in-memory only: never logged, never
// written to disk, never surfaced through GET /state. Losing it on restart is acceptable and
// by design, since borrowers can re-enroll; leaking it is not recoverable.
type Extension struct {
	mu      sync.RWMutex
	Server  *http.Server
	secrets map[secretKey]types.SecretPolicy

	enrolled    int
	evaluations int
	verdicts    int

	chain  *chainReader
	signer *signClient
}

func New(extensionPort, signPort int) *Extension {
	e := &Extension{
		secrets: make(map[secretKey]types.SecretPolicy),
		chain:   newChainReader(config.RPCURL),
		signer:  newSignClient(signPort),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", e.stateHandler)
	mux.HandleFunc("POST /action", e.actionHandler)

	e.Server = &http.Server{
		Addr:              fmt.Sprintf(":%d", extensionPort),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	return e
}

// stateHandler reports aggregate counters only. See the note on types.State: this endpoint is
// observable from outside the enclave, so per-borrower detail here would undo the design.
func (e *Extension) stateHandler(w http.ResponseWriter, r *http.Request) {
	e.mu.RLock()
	resp := types.StateResponse{
		StateVersion: teeutils.ToHash(config.Version),
		State: types.State{
			EnrolledPositions: e.enrolled,
			Evaluations:       e.evaluations,
			VerdictsIssued:    e.verdicts,
		},
	}
	e.mu.RUnlock()

	if err := json.NewEncoder(w).Encode(resp); err != nil {
		http.Error(w, fmt.Sprintf("sending response: %v", err), http.StatusInternalServerError)
	}
}

func (e *Extension) processAction(action teetypes.Action) (int, []byte) {
	df, err := processorutils.Parse[instruction.DataFixed](action.Data.Message)
	if err != nil {
		return http.StatusBadRequest, []byte(fmt.Sprintf("decoding fixed data: %v", err))
	}

	if df.OPType != teeutils.ToHash(config.OPTypeBallast) {
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type %s, expected %s", df.OPType.Hex(), config.OPTypeBallast))
	}

	switch df.OPCommand {
	case teeutils.ToHash(config.OPCommandEnroll):
		return ok(e.processEnroll(action, df))
	case teeutils.ToHash(config.OPCommandEvaluate):
		return ok(e.processEvaluate(action, df))
	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command %s", df.OPCommand.Hex()))
	}
}

func ok(ar teetypes.ActionResult) (int, []byte) {
	b, _ := json.Marshal(ar)
	return http.StatusOK, b
}

// processEnroll takes a borrower's encrypted policy into enclave memory.
//
// The commitment check is the load-bearing step. Without it a borrower could publish one
// commitment on-chain and hand the enclave a different, more aggressive policy, and the
// on-chain contract would happily accept verdicts for it because the commitment it compares
// against is whatever the verdict carries. Binding the two here is what makes the commitment
// mean anything.
func (e *Extension) processEnroll(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	var req types.EnrollRequest
	if err := decodeTuple(types.EnrollMessageArg, df.OriginalMessage, &req); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding enroll request: %w", err))
	}

	plaintext, err := e.signer.decrypt(req.Ciphertext)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decrypting policy: %w", err))
	}

	var policy types.SecretPolicy
	if err := json.Unmarshal(plaintext, &policy); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("parsing policy: %w", err))
	}
	if policy.TriggerHealth == nil || policy.TargetHealth == nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("policy missing trigger or target"))
	}

	if got := commitmentOf(policy); got != req.Commitment {
		return buildResult(action, df, nil, 0,
			fmt.Errorf("policy does not match published commitment"))
	}

	e.mu.Lock()
	k := secretKey{borrower: req.Borrower, market: req.MarketID}
	if _, existed := e.secrets[k]; !existed {
		e.enrolled++
	}
	e.secrets[k] = policy
	e.mu.Unlock()

	// The response carries no policy detail. An ack is all the caller needs, and the result
	// payload is public once it reaches the proxy.
	return buildResult(action, df, []byte{1}, 1, nil)
}

// processEvaluate decides whether a position has crossed its secret trigger.
//
// Reads are pinned to the block carried in the request so that every machine serving this
// extension sees identical state and produces identical result bytes. Evaluating at "latest"
// would make signatures disagree the moment the chain moved between machines.
func (e *Extension) processEvaluate(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	var req types.EvaluateRequest
	if err := decodeTuple(types.EvaluateMessageArg, df.OriginalMessage, &req); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding evaluate request: %w", err))
	}

	e.mu.RLock()
	policy, known := e.secrets[secretKey{borrower: req.Borrower, market: req.MarketID}]
	e.mu.RUnlock()
	if !known {
		return buildResult(action, df, nil, 0, fmt.Errorf("position not enrolled"))
	}

	health, err := e.chain.healthAt(req.Borrower, req.MarketID, req.BlockNumber)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("reading position: %w", err))
	}

	e.mu.Lock()
	e.evaluations++
	e.mu.Unlock()

	// Not yet at the trigger. Returning success with an empty payload is deliberate: a
	// "nothing to do" answer is a legitimate result, not a handler failure, and the caller
	// learns only that no action was warranted, never how far away the trigger was.
	if health.Cmp(policy.TriggerHealth) >= 0 {
		return buildResult(action, df, []byte{}, 1, nil)
	}

	verdict := types.Verdict{
		Borrower:         req.Borrower,
		ID:               req.MarketID,
		Commitment:       commitmentOf(policy),
		TargetHealth:     policy.TargetHealth,
		MaxSlippageBps:   defaultSlippageBps,
		EvaluatedAtBlock: req.BlockNumber,
		Salt:             policy.Salt,
	}

	encoded, err := abi.Arguments{types.VerdictArg}.Pack(verdict)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("encoding verdict: %w", err))
	}

	e.mu.Lock()
	e.verdicts++
	e.mu.Unlock()

	return buildResult(action, df, encoded, 1, nil)
}

// defaultSlippageBps is what the enclave asks for. BallastManagerV2 clamps it down to the
// borrower's policy, so this is a request, never a grant.
const defaultSlippageBps = 100

// commitmentOf mirrors ConfidentialTrigger.commitmentFor: keccak256(abi.encode(trigger,
// target, salt)) with the two healths as uint128 and the salt as bytes32.
func commitmentOf(p types.SecretPolicy) common.Hash {
	buf := make([]byte, 0, 96)
	buf = append(buf, common.LeftPadBytes(p.TriggerHealth.Bytes(), 32)...)
	buf = append(buf, common.LeftPadBytes(p.TargetHealth.Bytes(), 32)...)
	buf = append(buf, p.Salt[:]...)
	return crypto.Keccak256Hash(buf)
}

func decodeTuple(arg abi.Argument, data []byte, out any) error {
	values, err := abi.Arguments{arg}.Unpack(data)
	if err != nil {
		return err
	}
	if len(values) != 1 {
		return fmt.Errorf("expected 1 tuple, got %d", len(values))
	}
	encoded, err := json.Marshal(values[0])
	if err != nil {
		return err
	}
	return json.NewDecoder(bytes.NewReader(encoded)).Decode(out)
}
