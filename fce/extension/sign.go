package extension

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	teetypes "github.com/flare-foundation/tee-node/pkg/types"
)

// signClient talks to the tee-node sign sidecar.
//
// The extension never holds the machine's private key. Decryption happens behind POST /decrypt
// on the sidecar, which is what lets a borrower encrypt their policy to the key published by
// MachineManagerFacet.getPublicKey and have only an attested machine able to open it.
type signClient struct {
	baseURL string
	http    *http.Client
}

func newSignClient(signPort int) *signClient {
	return &signClient{
		baseURL: fmt.Sprintf("http://127.0.0.1:%d", signPort),
		http:    &http.Client{Timeout: 10 * time.Second},
	}
}

// decrypt opens a message that was ECIES-encrypted to this machine's public key.
func (s *signClient) decrypt(ciphertext []byte) ([]byte, error) {
	body, err := json.Marshal(teetypes.DecryptRequest{EncryptedMessage: ciphertext})
	if err != nil {
		return nil, err
	}

	resp, err := s.http.Post(s.baseURL+"/decrypt", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("calling sign sidecar: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("sign sidecar returned %d", resp.StatusCode)
	}

	var out teetypes.DecryptResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decoding decrypt response: %w", err)
	}
	return out.DecryptedMessage, nil
}
