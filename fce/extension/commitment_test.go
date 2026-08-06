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

func TestValidatePolicy(t *testing.T) {
	valid := types.SecretPolicy{
		TriggerHealth: new(big.Int).Set(wad),
		TargetHealth:  new(big.Int).Add(new(big.Int).Set(wad), big.NewInt(1)),
	}
	if err := validatePolicy(valid); err != nil {
		t.Fatalf("valid policy rejected: %v", err)
	}

	tests := []struct {
		name    string
		trigger *big.Int
		target  *big.Int
	}{
		{"trigger below liquidation", new(big.Int).Sub(new(big.Int).Set(wad), big.NewInt(1)), new(big.Int).Mul(wad, big.NewInt(2))},
		{"target equals trigger", new(big.Int).Set(wad), new(big.Int).Set(wad)},
		{"negative trigger", big.NewInt(-1), new(big.Int).Set(wad)},
		{"trigger exceeds uint128", new(big.Int).Lsh(big.NewInt(1), 128), new(big.Int).Lsh(big.NewInt(1), 129)},
		{"target exceeds uint128", new(big.Int).Set(wad), new(big.Int).Lsh(big.NewInt(1), 128)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validatePolicy(types.SecretPolicy{TriggerHealth: tt.trigger, TargetHealth: tt.target}); err == nil {
				t.Fatal("invalid policy accepted")
			}
		})
	}
}

func TestAccrueBorrowAssetsMatchesMorphoTaylorTerms(t *testing.T) {
	assets := big.NewInt(1_000_000_000)
	rate := big.NewInt(1_000_000_000_000) // 1e-6 per second, WAD-scaled.
	elapsed := big.NewInt(1_000)

	got := accrueBorrowAssets(assets, rate, elapsed)
	// x*n = 1e15, second = 5e11, third = 1.66666666e8.
	want := big.NewInt(1_001_000_500)
	if got.Cmp(want) != 0 {
		t.Fatalf("accrued assets mismatch: got %s, want %s", got, want)
	}
}
