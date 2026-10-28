package sessionprotocol

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonobject"
)

const maxTextBytes = 1_048_576

func object(data []byte, keys ...string) (map[string]json.RawMessage, error) {
	fields, err := jsonobject.Decode(data, "session protocol", keys...)
	if err != nil || len(fields) != len(keys) {
		return nil, errInvalid
	}
	return fields, nil
}

func array(data []byte) ([]json.RawMessage, error) {
	data = bytes.TrimSpace(data)
	var values []json.RawMessage
	if len(data) == 0 || data[0] != '[' || json.Unmarshal(data, &values) != nil || len(values) > 1000 {
		return nil, errInvalid
	}
	return values, nil
}

func stringField(data []byte) string {
	var value string
	if json.Unmarshal(data, &value) != nil {
		return ""
	}
	return value
}

func stringValue(data []byte, allowEmpty bool, maxBytes int) bool {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || data[0] != '"' {
		return false
	}
	var value string
	if json.Unmarshal(data, &value) != nil || strings.ContainsRune(value, 0) || (!allowEmpty && strings.TrimFunc(value, unicode.IsSpace) == "") {
		return false
	}
	if len(value) > maxBytes {
		return false
	}
	return true
}

func nullableString(data []byte, allowEmpty bool, maxBytes int) bool {
	return bytes.Equal(bytes.TrimSpace(data), []byte("null")) || stringValue(data, allowEmpty, maxBytes)
}

func uniqueKey(data []byte, seen map[string]bool) bool {
	if !stringValue(data, false, 256) {
		return false
	}
	value := stringField(data)
	if seen[value] {
		return false
	}
	seen[value] = true
	return true
}

func uniqueStrings(data []byte) bool {
	values, err := array(data)
	if err != nil {
		return false
	}
	seen := map[string]bool{}
	for _, value := range values {
		if !uniqueKey(value, seen) {
			return false
		}
	}
	return true
}

func formValue(data []byte) bool {
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return false
	}
	switch data[0] {
	case '"':
		return stringValue(data, true, maxTextBytes)
	case '[':
		return uniqueStrings(data)
	case 't', 'f':
		return bytes.Equal(data, []byte("true")) || bytes.Equal(data, []byte("false"))
	case 'n':
		return false
	default:
		var value float64
		return json.Unmarshal(data, &value) == nil
	}
}

// encoding/json replaces invalid UTF-8 and lone UTF-16 surrogates. The shared
// TypeScript contract rejects them, so validate before decoding any string.
func validUnicode(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	for i := 0; i < len(data); i++ {
		if data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) {
			return false
		}
		if data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return false
		}
		first, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if first >= 0xdc00 && first <= 0xdfff {
			return false
		}
		if first < 0xd800 || first > 0xdbff {
			continue
		}
		if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
			return false
		}
		second, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
		if err != nil || second < 0xdc00 || second > 0xdfff {
			return false
		}
		i += 6
	}
	return true
}
