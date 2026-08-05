package extension

import (
	"math/big"
	"testing"

	"ballast-fce/types"

	"github.com/ethereum/go-ethereum/common"
)

// TestCommitmentMatchesSolidity pins the Go commitment against the Solidity one.
//
// This is the enrollment equivalent of the signing-digest problem: if the two languages hash
// the same policy differently, every enrollment is rejected as "policy does not match
// published commitment" and nothing about the error says why. The same fixture is asserted in
// test/ConfidentialTrigger.t.sol against ConfidentialTrigger.commitmentFor.
func TestCommitmentMatchesSolidity(t *testing.T) {
	trigger, _ := new(big.Int).SetString("1050000000000000000", 10) // 1.05e18
	target, _ := new(big.Int).SetString("1350000000000000000", 10)  // 1.35e18

	var salt [32]byte
	copy(salt[:], common.LeftPadBytes(big.NewInt(0xDEADBEEF).Bytes(), 32))

	got := commitmentOf(types.SecretPolicy{
		TriggerHealth: trigger,
		TargetHealth:  target,
		Salt:          salt,
	})

	const want = "0x164ab6ff7d824a82cd45bc5202021b6c3e717b8b2ad68b66a689ecb46fa84d87"
	if got.Hex() != want {
		t.Fatalf("commitment mismatch:\n  go       = %s\n  expected = %s", got.Hex(), want)
	}
}
