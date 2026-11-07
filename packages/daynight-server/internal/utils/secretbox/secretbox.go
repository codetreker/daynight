package secretbox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

const envelopeVersion = 1

var (
	ErrKeyUnavailable  = errors.New("encryption key is unavailable")
	ErrEnvelopeInvalid = errors.New("encrypted envelope is invalid")
	ErrAuthentication  = errors.New("encrypted value could not be authenticated")
)

type Envelope struct {
	Version     int    `json:"version"`
	MasterKeyID string `json:"masterKeyId"`
	Nonce       []byte `json:"nonce"`
	Ciphertext  []byte `json:"ciphertext"`
}

// Keyring retains an immutable active key and the keys needed to recover
// previously encrypted records. Application owners construct a new runtime
// before changing its active key.
type Keyring struct {
	active string
	keys   map[string]cipher.AEAD
	random io.Reader
}

func New(data []byte) (*Keyring, error) {
	return newKeyring(data, rand.Reader)
}

func newKeyring(data []byte, random io.Reader) (*Keyring, error) {
	if !jsonunicode.Valid(data) {
		return nil, errors.New("keyring must contain valid Unicode JSON")
	}
	fields, err := jsonobject.Decode(data, "keyring", "activeKeyId", "keys")
	if err != nil {
		return nil, err
	}
	var active string
	if err := json.Unmarshal(fields["activeKeyId"], &active); err != nil || !validKeyID(active) {
		return nil, errors.New("keyring activeKeyId must be a valid key identifier")
	}
	var candidate map[string]json.RawMessage
	if err := json.Unmarshal(fields["keys"], &candidate); err != nil || len(candidate) == 0 {
		return nil, errors.New("keyring keys must be a nonempty object")
	}
	ids := make([]string, 0, len(candidate))
	for id := range candidate {
		if !validKeyID(id) {
			return nil, errors.New("keyring contains an invalid key identifier")
		}
		ids = append(ids, id)
	}
	entries, err := jsonobject.Decode(fields["keys"], "keyring keys", ids...)
	if err != nil {
		return nil, err
	}
	keys := make(map[string]cipher.AEAD, len(entries))
	for id, encodedValue := range entries {
		var encoded string
		if err := json.Unmarshal(encodedValue, &encoded); err != nil {
			return nil, errors.New("keyring keys must be Base64 strings")
		}
		key, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil || len(key) != 32 || base64.StdEncoding.EncodeToString(key) != encoded {
			return nil, errors.New("keyring keys must be canonical Base64 of 32 bytes")
		}
		block, err := aes.NewCipher(key)
		clear(key)
		if err != nil {
			return nil, fmt.Errorf("construct encryption key: %w", err)
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return nil, fmt.Errorf("construct authenticated cipher: %w", err)
		}
		keys[id] = aead
	}
	if _, exists := keys[active]; !exists {
		return nil, fmt.Errorf("active key: %w", ErrKeyUnavailable)
	}
	return &Keyring{active: active, keys: keys, random: random}, nil
}

func (k *Keyring) ActiveKeyID() string {
	return k.active
}

func (k *Keyring) HasKey(id string) bool {
	_, exists := k.keys[id]
	return exists
}

func (k *Keyring) KeyIDs() []string {
	ids := make([]string, 0, len(k.keys))
	for id := range k.keys {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

func (k *Keyring) Seal(plaintext, associatedData []byte) (Envelope, error) {
	aead := k.keys[k.active]
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(k.random, nonce); err != nil {
		return Envelope{}, fmt.Errorf("generate encryption nonce: %w", err)
	}
	return Envelope{
		Version: envelopeVersion, MasterKeyID: k.active, Nonce: nonce,
		Ciphertext: aead.Seal(nil, nonce, plaintext, envelopeAAD(k.active, associatedData)),
	}, nil
}

func (k *Keyring) Open(envelope Envelope, associatedData []byte) ([]byte, error) {
	if envelope.Version != envelopeVersion || !validKeyID(envelope.MasterKeyID) || len(envelope.Nonce) != 12 || len(envelope.Ciphertext) < 16 {
		return nil, ErrEnvelopeInvalid
	}
	aead, exists := k.keys[envelope.MasterKeyID]
	if !exists {
		return nil, ErrKeyUnavailable
	}
	plaintext, err := aead.Open(nil, envelope.Nonce, envelope.Ciphertext, envelopeAAD(envelope.MasterKeyID, associatedData))
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrAuthentication, err)
	}
	return plaintext, nil
}

func validKeyID(id string) bool {
	if len(id) == 0 || len(id) > 64 {
		return false
	}
	for index, character := range id {
		alphanumeric := character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9'
		if !alphanumeric && (index == 0 || !strings.ContainsRune("._-", character)) {
			return false
		}
	}
	return true
}

// The envelope key identity is authenticated as well as the caller's opaque
// resource context, including when two retained key IDs contain equal keys.
func envelopeAAD(keyID string, associatedData []byte) []byte {
	result := make([]byte, 0, len("secretbox:v1\x00")+len(keyID)+1+len(associatedData))
	result = append(result, "secretbox:v1\x00"...)
	result = append(result, keyID...)
	result = append(result, 0)
	return append(result, associatedData...)
}
