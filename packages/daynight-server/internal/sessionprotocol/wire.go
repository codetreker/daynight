package sessionprotocol

import (
	"bytes"
	"encoding/json"
)

// MarshalWire encodes session JSON without HTML escaping. Session payloads are
// served as application/json or WebSocket text, never embedded in HTML. Keeping
// their wire representation bounded avoids expanding valid native tool output.
// Durable operation hashes deliberately retain their original JSON encoding.
func MarshalWire(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}
