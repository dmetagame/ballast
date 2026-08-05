package extension

import (
	"encoding/json"
	"fmt"
	"net/http"

	"ballast-fce/config"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
)

// --- Framework code, copied verbatim from fce-extension-scaffold's
// --- go/internal/extension/utils.go. It lives here only so this package builds and tests
// --- standalone. When these files are dropped into the scaffold, DELETE this file: the
// --- scaffold provides both functions and duplicate definitions will not compile.
//
// The `Log` values are part of the wire contract, see the scaffold's
// docs/extension-contract.md section 4.6.

func (e *Extension) actionHandler(w http.ResponseWriter, r *http.Request) {
	var action teetypes.Action
	if err := json.NewDecoder(r.Body).Decode(&action); err != nil {
		http.Error(w, fmt.Sprintf("decoding action: %v", err), http.StatusBadRequest)
		return
	}

	status, body := e.processAction(action)
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func buildResult(
	a teetypes.Action, df *instruction.DataFixed, data []byte, status uint8, err error,
) teetypes.ActionResult {
	ar := teetypes.ActionResult{
		ID:            a.Data.ID,
		SubmissionTag: a.Data.SubmissionTag,
		Version:       config.Version,
		OPType:        df.OPType,
		OPCommand:     df.OPCommand,
		Data:          data,
		Status:        status,
	}
	switch status {
	case 0:
		ar.Log = fmt.Sprintf("error: %v", err)
	case 1:
		ar.Log = "ok"
	default:
		ar.Log = "pending"
	}
	return ar
}
