// Package secretbox provides recoverable authenticated encryption with an
// immutable runtime keyring. Callers supply the resource-specific binding.
package secretbox

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

const envelopeVersion = 1

var (
	ErrInvalidKeyring  = errors.New("invalid keyring")
	ErrInvalidEnvelope = errors.New("invalid secretbox envelope")
	ErrMissingKey      = errors.New("secretbox master key unavailable")
	ErrAuthentication  = errors.New("secretbox authentication failed")
)

// Envelope is stored along with the resource. Version and MasterKeyID are
// authenticated as well as the ciphertext and nonce.
type Envelope struct {
	Version     int
	MasterKeyID string
	Nonce       []byte
	Ciphertext  []byte
}

// Keyring owns private copies of the master keys. Its active key is fixed for
// the lifetime of the instance; construct another instance to change it.
type Keyring struct {
	active string
	keys   map[string][32]byte
}

// Parse reads exactly one keyring JSON object without accepting duplicate,
// unknown, null, malformed Unicode, or noncanonical base64 fields.
func Parse(data []byte) (*Keyring, error) {
	if !jsonunicode.Valid(data) {
		return nil, fmt.Errorf("%w: malformed Unicode", ErrInvalidKeyring)
	}
	fields, err := jsonobject.Decode(data, "keyring", "activeKeyId", "keys")
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidKeyring, err)
	}
	var active string
	if len(fields) != 2 || json.Unmarshal(fields["activeKeyId"], &active) != nil || !validKeyID(active) {
		return nil, fmt.Errorf("%w: invalid active key ID", ErrInvalidKeyring)
	}
	decoder := json.NewDecoder(bytes.NewReader(fields["keys"]))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, fmt.Errorf("%w: keys must be an object", ErrInvalidKeyring)
	}
	keys := make(map[string][32]byte)
	for decoder.More() {
		token, err := decoder.Token()
		id, ok := token.(string)
		if err != nil || !ok || !validKeyID(id) {
			return nil, fmt.Errorf("%w: invalid key ID", ErrInvalidKeyring)
		}
		if _, exists := keys[id]; exists {
			return nil, fmt.Errorf("%w: duplicate key ID", ErrInvalidKeyring)
		}
		var encoded string
		if err := decoder.Decode(&encoded); err != nil {
			return nil, fmt.Errorf("%w: invalid key value", ErrInvalidKeyring)
		}
		decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil || len(decoded) != 32 || base64.StdEncoding.EncodeToString(decoded) != encoded {
			return nil, fmt.Errorf("%w: invalid key encoding", ErrInvalidKeyring)
		}
		var key [32]byte
		copy(key[:], decoded)
		keys[id] = key
	}
	if _, err := decoder.Token(); err != nil {
		return nil, fmt.Errorf("%w: invalid keys object", ErrInvalidKeyring)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("%w: invalid keys object", ErrInvalidKeyring)
	}
	if _, ok := keys[active]; !ok {
		return nil, fmt.Errorf("%w: active key is missing", ErrInvalidKeyring)
	}
	return &Keyring{active: active, keys: keys}, nil
}

// Read reads a keyring from its deployment source and preserves read failures.
func Read(r io.Reader) (*Keyring, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("read keyring: %w", err)
	}
	return Parse(data)
}

func validKeyID(id string) bool {
	if len(id) == 0 || len(id) > 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		alnum := c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9'
		if !alnum && (i == 0 || c != '.' && c != '_' && c != '-') {
			return false
		}
	}
	return true
}

func (k *Keyring) ActiveKeyID() string { return k.active }

// HasKey reports whether a master key reference can be opened by this keyring.
func (k *Keyring) HasKey(id string) bool {
	if k == nil {
		return false
	}
	_, ok := k.keys[id]
	return ok
}

// Seal always uses the runtime's active master key. A nil random source uses
// crypto/rand; another source allows controlled failure injection.
func (k *Keyring) Seal(plaintext []byte, binding []string, random io.Reader) (Envelope, error) {
	key := k.keys[k.active]
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return Envelope{}, fmt.Errorf("create secretbox cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return Envelope{}, fmt.Errorf("create secretbox AEAD: %w", err)
	}
	if random == nil {
		random = rand.Reader
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(random, nonce); err != nil {
		return Envelope{}, fmt.Errorf("generate secretbox nonce: %w", err)
	}
	aad, err := additionalData(envelopeVersion, k.active, nonce, binding)
	if err != nil {
		return Envelope{}, err
	}
	return Envelope{Version: envelopeVersion, MasterKeyID: k.active, Nonce: nonce, Ciphertext: gcm.Seal(nil, nonce, plaintext, aad)}, nil
}

// Open authenticates the envelope and binding using the named master key.
func (k *Keyring) Open(e Envelope, binding []string) ([]byte, error) {
	aad, err := additionalData(e.Version, e.MasterKeyID, e.Nonce, binding)
	if err != nil {
		return nil, err
	}
	key, ok := k.keys[e.MasterKeyID]
	if !ok {
		return nil, ErrMissingKey
	}
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, fmt.Errorf("create secretbox cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create secretbox AEAD: %w", err)
	}
	if len(e.Nonce) != gcm.NonceSize() || len(e.Ciphertext) < gcm.Overhead() {
		return nil, ErrInvalidEnvelope
	}
	plaintext, err := gcm.Open(nil, e.Nonce, e.Ciphertext, aad)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrAuthentication, err)
	}
	return plaintext, nil
}

func additionalData(version int, id string, nonce []byte, binding []string) ([]byte, error) {
	header, err := envelopeHeader(version, id, nonce)
	if err != nil || len(binding) == 0 {
		return nil, ErrInvalidEnvelope
	}
	parts := make([]string, 0, len(binding)+2)
	parts = append(parts, "daynight-secretbox", "1")
	for _, part := range binding {
		if part == "" || !utf8.ValidString(part) || strings.ContainsRune(part, '\x00') {
			return nil, ErrInvalidEnvelope
		}
		parts = append(parts, part)
	}
	return append(header, []byte(strings.Join(parts, "\x00"))...), nil
}

func envelopeHeader(version int, id string, nonce []byte) ([]byte, error) {
	if version != envelopeVersion || !validKeyID(id) || len(nonce) != 12 {
		return nil, ErrInvalidEnvelope
	}
	header := make([]byte, 3+len(id)+12)
	binary.BigEndian.PutUint16(header, uint16(version))
	header[2] = byte(len(id))
	copy(header[3:], id)
	copy(header[3+len(id):], nonce)
	return header, nil
}

// MarshalBinary encodes the canonical envelope; the authentication tag is
// already part of Ciphertext.
func (e Envelope) MarshalBinary() ([]byte, error) {
	header, err := envelopeHeader(e.Version, e.MasterKeyID, e.Nonce)
	if err != nil || len(e.Ciphertext) < 16 {
		return nil, ErrInvalidEnvelope
	}
	return append(header, e.Ciphertext...), nil
}

// ParseEnvelope decodes canonical bytes into independently storable fields.
func ParseEnvelope(data []byte) (Envelope, error) {
	if len(data) < 3 {
		return Envelope{}, ErrInvalidEnvelope
	}
	n := int(data[2])
	if len(data) < 3+n+12+16 {
		return Envelope{}, ErrInvalidEnvelope
	}
	e := Envelope{Version: int(binary.BigEndian.Uint16(data)), MasterKeyID: string(data[3 : 3+n]),
		Nonce: bytes.Clone(data[3+n : 3+n+12]), Ciphertext: bytes.Clone(data[3+n+12:])}
	if _, err := envelopeHeader(e.Version, e.MasterKeyID, e.Nonce); err != nil {
		return Envelope{}, err
	}
	return e, nil
}
