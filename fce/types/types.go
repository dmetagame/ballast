// Package types describes the payloads exchanged with the Ballast extension.
package types

import (
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

// EnrollRequest is the ABI-decoded payload of an ENROLL instruction.
//
// Ciphertext is the borrower's secret policy, ECIES-encrypted to the TEE machine's public key
// (MachineManagerFacet.getPublicKey). This matters: instructions reach the enclave through a
// public TeeInstructionsSent event, so anything not encrypted here is world-readable and the
// whole design collapses. The commitment travels in the clear on purpose, so the enclave can
// check the plaintext it decrypts is the one the borrower published on-chain.
// Field names and types must match what geth's ABI decoder produces, not what reads nicely.
// bytes32 decodes to [32]byte (never common.Hash), and geth capitalises only the first letter,
// so the field for `marketId` must be `MarketId` and not `MarketID`. Both mistakes fail at
// runtime with a decode error that does not mention either cause.
type EnrollRequest struct {
	Borrower   common.Address
	MarketId   [32]byte
	Commitment [32]byte
	Ciphertext []byte
}

// SecretPolicy is what the ciphertext decrypts to. It never leaves the enclave.
type SecretPolicy struct {
	TriggerHealth *big.Int `json:"triggerHealth"`
	TargetHealth  *big.Int `json:"targetHealth"`
	Salt          [32]byte `json:"salt"`
}

// EvaluateRequest is the ABI-decoded payload of an EVALUATE instruction.
//
// BlockNumber pins the chain height every machine reads at. Without it, two machines
// evaluating a moving market produce different result bytes, and the TEE stack requires
// result data to be byte-exact for a signature to be usable.
type EvaluateRequest struct {
	Borrower    common.Address
	MarketId    [32]byte
	BlockNumber uint64
}

// Verdict mirrors ConfidentialTrigger.Verdict in Solidity, field for field and in order.
// It is ABI-encoded into ActionResult.Data, which is what the TEE signature commits to.
type Verdict struct {
	Borrower         common.Address `abi:"borrower"`
	ID               [32]byte       `abi:"id"`
	Commitment       [32]byte       `abi:"commitment"`
	TargetHealth     *big.Int       `abi:"targetHealth"`
	MaxSlippageBps   uint32         `abi:"maxSlippageBps"`
	EvaluatedAtBlock uint64         `abi:"evaluatedAtBlock"`
	Salt             [32]byte       `abi:"salt"`
}

// VerdictArg is the abi.Argument matching ConfidentialTrigger.Verdict.
//
// Every member is static, so the tuple packs inline as seven words with no offset header,
// which is exactly what Solidity's abi.encode(v) produces for the same struct.
var VerdictArg abi.Argument

// EnrollMessageArg and EvaluateMessageArg describe the instruction payloads emitted by
// BallastInstructionSender.sol.
var (
	EnrollMessageArg   abi.Argument
	EvaluateMessageArg abi.Argument
)

func init() {
	verdictTy, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "borrower", Type: "address"},
		{Name: "id", Type: "bytes32"},
		{Name: "commitment", Type: "bytes32"},
		{Name: "targetHealth", Type: "uint128"},
		{Name: "maxSlippageBps", Type: "uint32"},
		{Name: "evaluatedAtBlock", Type: "uint64"},
		{Name: "salt", Type: "bytes32"},
	})
	if err != nil {
		panic(err)
	}
	VerdictArg = abi.Argument{Type: verdictTy}

	enrollTy, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "borrower", Type: "address"},
		{Name: "marketId", Type: "bytes32"},
		{Name: "commitment", Type: "bytes32"},
		{Name: "ciphertext", Type: "bytes"},
	})
	if err != nil {
		panic(err)
	}
	EnrollMessageArg = abi.Argument{Type: enrollTy}

	evaluateTy, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "borrower", Type: "address"},
		{Name: "marketId", Type: "bytes32"},
		{Name: "blockNumber", Type: "uint64"},
	})
	if err != nil {
		panic(err)
	}
	EvaluateMessageArg = abi.Argument{Type: evaluateTy}
}

// State is returned by GET /state.
//
// It deliberately exposes counts and nothing else. The state endpoint is observable outside
// the enclave, so putting a trigger level, a salt, or even a per-borrower breakdown here would
// hand back exactly the secret the extension exists to keep. Aggregate counters only.
type State struct {
	EnrolledPositions int `json:"enrolledPositions"`
	Evaluations       int `json:"evaluations"`
	VerdictsIssued    int `json:"verdictsIssued"`
}

// --- DO NOT MODIFY below this line. ---

// StateResponse is the envelope returned by GET /state.
type StateResponse struct {
	StateVersion common.Hash `json:"stateVersion"`
	State        State       `json:"state"`
}
