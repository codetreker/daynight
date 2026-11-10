package session

import (
	"bytes"
	"encoding/json"
	"sort"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

// History entries include finite fractional form bounds, unlike v2 control
// messages. Preserve that existing entry contract while using the same string
// encoding and sorted object fields as the control protocol.
func canonicalHistoryJSON(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var decoded any
	if err = json.Unmarshal(raw, &decoded); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	var write func(any) error
	write = func(v any) error {
		switch x := v.(type) {
		case map[string]any:
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			out.WriteByte('{')
			for i, k := range keys {
				if i > 0 {
					out.WriteByte(',')
				}
				quoted, e := v2.CanonicalJSON(k)
				if e != nil {
					return e
				}
				out.Write(quoted)
				out.WriteByte(':')
				if e = write(x[k]); e != nil {
					return e
				}
			}
			out.WriteByte('}')
		case []any:
			out.WriteByte('[')
			for i, item := range x {
				if i > 0 {
					out.WriteByte(',')
				}
				if e := write(item); e != nil {
					return e
				}
			}
			out.WriteByte(']')
		case float64:
			if x == 0 {
				out.WriteByte('0')
			} else {
				number, e := json.Marshal(x)
				if e != nil {
					return e
				}
				out.Write(number)
			}
		default:
			scalar, e := v2.CanonicalJSON(x)
			if e != nil {
				return e
			}
			out.Write(scalar)
		}
		return nil
	}
	if err = write(decoded); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
