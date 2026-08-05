package extension

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

// virtualShares and virtualAssets are Morpho Blue's share-accounting constants. Health has to
// be computed the way Morpho itself computes it, or the enclave's idea of the liquidation line
// drifts from the one that actually seizes collateral.
var (
	virtualShares = big.NewInt(1e6)
	virtualAssets = big.NewInt(1)
	// oraclePriceScale is 1e36, Morpho's oracle scaling factor.
	oraclePriceScale = new(big.Int).Exp(big.NewInt(10), big.NewInt(36), nil)
)

// Selectors on Morpho Blue and the market oracle.
var (
	selPosition         = crypto.Keccak256([]byte("position(bytes32,address)"))[:4]
	selMarket           = crypto.Keccak256([]byte("market(bytes32)"))[:4]
	selIdToMarketParams = crypto.Keccak256([]byte("idToMarketParams(bytes32)"))[:4]
	selPrice            = crypto.Keccak256([]byte("price()"))[:4]
)

type chainReader struct {
	rpcURL string
	morpho common.Address
}

func newChainReader(rpcURL, morpho string) *chainReader {
	return &chainReader{rpcURL: rpcURL, morpho: common.HexToAddress(morpho)}
}

// healthAt returns the position's health factor in WAD, read at a pinned block.
func (c *chainReader) healthAt(borrower common.Address, market common.Hash, blockNumber uint64) (*big.Int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	client, err := ethclient.DialContext(ctx, c.rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dialing %s: %w", c.rpcURL, err)
	}
	defer client.Close()

	at := new(big.Int).SetUint64(blockNumber)

	call := func(to common.Address, data []byte) ([]byte, error) {
		return client.CallContract(ctx, ethereum.CallMsg{To: &to, Data: data}, at)
	}

	// position(id, borrower) -> (supplyShares, borrowShares, collateral)
	posOut, err := call(c.morpho, append(append([]byte{}, selPosition...),
		append(market.Bytes(), common.LeftPadBytes(borrower.Bytes(), 32)...)...))
	if err != nil {
		return nil, fmt.Errorf("position: %w", err)
	}
	if len(posOut) < 96 {
		return nil, fmt.Errorf("position returned %d bytes", len(posOut))
	}
	borrowShares := new(big.Int).SetBytes(posOut[32:64])
	collateral := new(big.Int).SetBytes(posOut[64:96])

	// market(id) -> (totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, ...)
	mktOut, err := call(c.morpho, append(append([]byte{}, selMarket...), market.Bytes()...))
	if err != nil {
		return nil, fmt.Errorf("market: %w", err)
	}
	if len(mktOut) < 128 {
		return nil, fmt.Errorf("market returned %d bytes", len(mktOut))
	}
	totalBorrowAssets := new(big.Int).SetBytes(mktOut[64:96])
	totalBorrowShares := new(big.Int).SetBytes(mktOut[96:128])

	// idToMarketParams(id) -> (loanToken, collateralToken, oracle, irm, lltv)
	mpOut, err := call(c.morpho, append(append([]byte{}, selIdToMarketParams...), market.Bytes()...))
	if err != nil {
		return nil, fmt.Errorf("idToMarketParams: %w", err)
	}
	if len(mpOut) < 160 {
		return nil, fmt.Errorf("idToMarketParams returned %d bytes", len(mpOut))
	}
	oracle := common.BytesToAddress(mpOut[64:96])
	lltv := new(big.Int).SetBytes(mpOut[128:160])

	priceOut, err := call(oracle, selPrice)
	if err != nil {
		return nil, fmt.Errorf("oracle price: %w", err)
	}
	if len(priceOut) < 32 {
		return nil, fmt.Errorf("oracle returned %d bytes", len(priceOut))
	}
	price := new(big.Int).SetBytes(priceOut[:32])

	debt := toAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares)
	if debt.Sign() == 0 {
		// Debt-free positions can never be liquidated; report the maximum so no verdict fires.
		return new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1)), nil
	}

	cv := new(big.Int).Div(new(big.Int).Mul(collateral, price), oraclePriceScale)
	maxBorrow := new(big.Int).Div(new(big.Int).Mul(cv, lltv), wad)
	return new(big.Int).Div(new(big.Int).Mul(maxBorrow, wad), debt), nil
}

// toAssetsUp mirrors Morpho's SharesMathLib: mulDivUp(shares, totalAssets + 1, totalShares + 1e6).
// Rounding up matters. Rounding the other way would make the enclave believe a position is
// marginally healthier than Morpho does, which is the wrong direction to be wrong in.
func toAssetsUp(shares, totalAssets, totalShares *big.Int) *big.Int {
	num := new(big.Int).Mul(shares, new(big.Int).Add(totalAssets, virtualAssets))
	den := new(big.Int).Add(totalShares, virtualShares)
	if den.Sign() == 0 {
		return big.NewInt(0)
	}
	q, r := new(big.Int).QuoRem(num, den, new(big.Int))
	if r.Sign() != 0 {
		q.Add(q, big.NewInt(1))
	}
	return q
}
