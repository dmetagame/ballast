// Package config holds the Ballast extension's operation constants and ports.
//
// These constants must match the bytes32 constants in BallastInstructionSender.sol exactly.
// They are compared as keccak-free right-padded bytes32 (teeutils.ToHash), so a typo here
// surfaces as "unsupported op type" at runtime rather than as a build error.
package config

import (
	"os"
	"strconv"
	"time"
)

const (
	// Version is reported by GET /state. Bump it whenever the state shape changes.
	Version = "0.1.0"

	// OPTypeBallast is the single operation type this extension serves.
	OPTypeBallast = "BALLAST"

	// OPCommandEnroll carries a borrower's encrypted trigger into the enclave.
	OPCommandEnroll = "ENROLL"

	// OPCommandEvaluate asks the enclave whether a position has crossed its secret trigger.
	OPCommandEvaluate = "EVALUATE"

	TimeoutShutdown = 5 * time.Second
)

// Defaults, overridden by the environment.
var (
	ExtensionPort = 8080
	SignPort      = 9090

	// RPCURL is the chain the enclave reads position and price state from. It must point at
	// the same chain the InstructionSender lives on, or evaluations describe a different world
	// than the one the verdict will be executed against.
	RPCURL = "https://coston2-api.flare.network/ext/C/rpc"

	// MorphoAddress is the Morpho Blue singleton the enclave reads positions from. It must
	// match the deployment ConfidentialTrigger's BallastManagerV2 acts on, or the enclave
	// judges a position that is not the one being protected.
	MorphoAddress = "0xF4346F5132e810f80a28487a79c7559d9797E8B0" // Flare mainnet
)

func init() {
	if v, err := strconv.Atoi(os.Getenv("EXTENSION_PORT")); err == nil && v != 0 {
		ExtensionPort = v
	}
	if v, err := strconv.Atoi(os.Getenv("SIGN_PORT")); err == nil && v != 0 {
		SignPort = v
	}
	if u := os.Getenv("RPC_URL"); u != "" {
		RPCURL = u
	}
	if m := os.Getenv("MORPHO_ADDRESS"); m != "" {
		MorphoAddress = m
	}
}
