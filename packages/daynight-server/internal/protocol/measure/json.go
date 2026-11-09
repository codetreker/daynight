// Package measure encodes protocol JSON with a bounded output budget.
package measure

import (
	"bufio"
	"encoding"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

// Writer rejects the first byte beyond Max. Actual on a violation is the first
// rejected size; it does not claim to measure the remainder of an oversized value.
type Writer struct {
	W          io.Writer
	Field      string
	Max, Count int64
}

func (w *Writer) Write(p []byte) (int, error) {
	if int64(len(p)) > w.Max-w.Count {
		return 0, &limit.Violation{Field: w.Field, Actual: w.Max + 1, Max: w.Max, Unit: "bytes", LowerBound: true}
	}
	n, err := w.W.Write(p)
	w.Count += int64(n)
	if err == nil && n != len(p) {
		err = io.ErrShortWrite
	}
	return n, err
}

// JSON encodes the supported protocol value shapes using encoding/json's default
// HTML escaping and optional Encoder newline. Supported types are JSON primitives,
// arrays, string-keyed maps, protocol structs, time.Time and json.RawMessage.
// Other custom marshalers, tagged strings and binary values are rejected. The
// caller must not modify the value while it is encoded. Output stops at budget.
func JSON(w io.Writer, field string, max int64, value any, newline bool) (int64, error) {
	if max < 0 {
		return 0, fmt.Errorf("negative JSON budget")
	}
	b := &Writer{W: w, Field: field, Max: max}
	err := encode(b, reflect.ValueOf(value))
	if err == nil && newline {
		_, err = io.WriteString(b, "\n")
	}
	return b.Count, err
}

var rawType = reflect.TypeOf(json.RawMessage{})
var timeType = reflect.TypeOf(time.Time{})

const jsonChunkBytes = 4096

func write(w io.Writer, s string) error { _, err := io.WriteString(w, s); return err }
func str(w io.Writer, s string) error {
	if err := write(w, "\""); err != nil {
		return err
	}
	for len(s) > 0 {
		n := jsonChunkBytes
		if n >= len(s) {
			n = len(s)
		} else {
			for n > 0 && !utf8.RuneStart(s[n]) {
				n--
			}
			if n == 0 {
				n = 1
			}
		}
		b, _ := json.Marshal(s[:n])
		if _, err := w.Write(b[1 : len(b)-1]); err != nil {
			return err
		}
		s = s[n:]
	}
	return write(w, "\"")
}
func raw(w io.Writer, b []byte) error {
	if b == nil {
		return write(w, "null")
	}
	if !json.Valid(b) {
		return fmt.Errorf("invalid JSON value")
	}
	output := bufio.NewWriterSize(w, min(len(b), jsonChunkBytes))
	start := 0
	in, escaped := false, false
	for i := 0; i < len(b); i++ {
		c := b[i]
		if !in && (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
			if err := rawSpan(output, b[start:i]); err != nil {
				return err
			}
			start = i + 1
			continue
		}
		replacement, size := "", 1
		if in && !escaped {
			switch c {
			case '<':
				replacement = "\\u003c"
			case '>':
				replacement = "\\u003e"
			case '&':
				replacement = "\\u0026"
			case 0xe2:
				if i+2 < len(b) && b[i+1] == 0x80 {
					switch b[i+2] {
					case 0xa8:
						replacement, size = "\\u2028", 3
					case 0xa9:
						replacement, size = "\\u2029", 3
					}
				}
			}
		}
		if replacement != "" {
			if start < i {
				if err := rawSpan(output, b[start:i]); err != nil {
					return err
				}
			}
			if _, err := output.WriteString(replacement); err != nil {
				return err
			}
			i += size - 1
			start = i + 1
			continue
		}
		if in {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				in = false
			}
		} else if c == '"' {
			in = true
		}
	}
	if err := rawSpan(output, b[start:]); err != nil {
		return err
	}
	return output.Flush()
}

// Empty buffered writers can forward a large write directly; spans retain the
// chunk bound on that path as well as when the buffer is partially filled.
func rawSpan(w *bufio.Writer, b []byte) error {
	for len(b) > 0 {
		n := min(len(b), jsonChunkBytes)
		if _, err := w.Write(b[:n]); err != nil {
			return err
		}
		b = b[n:]
	}
	return nil
}
func encode(w io.Writer, v reflect.Value) error {
	if !v.IsValid() {
		return write(w, "null")
	}
	if v.Kind() == reflect.Interface {
		if v.IsNil() {
			return write(w, "null")
		}
		return encode(w, v.Elem())
	}
	if v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return write(w, "null")
		}
		if v.Type().Elem() != rawType && v.Type().Elem() != timeType && v.CanInterface() {
			if _, ok := v.Interface().(json.Marshaler); ok {
				return fmt.Errorf("unsupported custom JSON marshaler %s", v.Type())
			}
			if _, ok := v.Interface().(encoding.TextMarshaler); ok {
				return fmt.Errorf("unsupported custom text marshaler %s", v.Type())
			}
		}
		return encode(w, v.Elem())
	}
	if v.Type() == rawType {
		return raw(w, v.Bytes())
	}
	if v.Type() == timeType {
		b, err := json.Marshal(v.Interface())
		if err != nil {
			return err
		}
		_, err = w.Write(b)
		return err
	}
	if v.Type() == reflect.TypeOf(json.Number("")) {
		return fmt.Errorf("unsupported JSON number")
	}
	if v.CanInterface() {
		if _, ok := v.Interface().(encoding.TextMarshaler); ok {
			return fmt.Errorf("unsupported custom text marshaler %s", v.Type())
		}
		if _, ok := v.Interface().(json.Marshaler); ok {
			return fmt.Errorf("unsupported custom JSON marshaler %s", v.Type())
		}
	}
	switch v.Kind() {
	case reflect.String:
		return str(w, v.String())
	case reflect.Bool:
		return write(w, strconv.FormatBool(v.Bool()))
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return write(w, strconv.FormatInt(v.Int(), 10))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return write(w, strconv.FormatUint(v.Uint(), 10))
	case reflect.Float32, reflect.Float64:
		f := v.Float()
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return fmt.Errorf("unsupported float")
		}
		b, err := json.Marshal(v.Interface())
		if err != nil {
			return err
		}
		_, err = w.Write(b)
		return err
	case reflect.Slice, reflect.Array:
		if v.Kind() == reflect.Slice && v.IsNil() {
			return write(w, "null")
		}
		if v.Type().Elem().Kind() == reflect.Uint8 {
			return fmt.Errorf("unsupported binary JSON value")
		}
		if err := write(w, "["); err != nil {
			return err
		}
		for i := 0; i < v.Len(); i++ {
			if i > 0 {
				if err := write(w, ","); err != nil {
					return err
				}
			}
			if err := encode(w, v.Index(i)); err != nil {
				return err
			}
		}
		return write(w, "]")
	case reflect.Map:
		if v.IsNil() {
			return write(w, "null")
		}
		if v.Type().Key().Kind() != reflect.String {
			return fmt.Errorf("unsupported JSON map key")
		}
		keys := v.MapKeys()
		sort.Slice(keys, func(i, j int) bool { return keys[i].String() < keys[j].String() })
		if err := write(w, "{"); err != nil {
			return err
		}
		for i, k := range keys {
			if i > 0 {
				if err := write(w, ","); err != nil {
					return err
				}
			}
			if err := str(w, k.String()); err != nil {
				return err
			}
			if err := write(w, ":"); err != nil {
				return err
			}
			if err := encode(w, v.MapIndex(k)); err != nil {
				return err
			}
		}
		return write(w, "}")
	case reflect.Struct:
		if err := write(w, "{"); err != nil {
			return err
		}
		first := true
		if err := fields(w, v, &first); err != nil {
			return err
		}
		return write(w, "}")
	default:
		return fmt.Errorf("unsupported JSON kind %s", v.Kind())
	}
}
func fields(w io.Writer, v reflect.Value, first *bool) error {
	t := v.Type()
	for i := 0; i < v.NumField(); i++ {
		f := t.Field(i)
		x := v.Field(i)
		if !f.IsExported() && !(f.Anonymous && x.Kind() == reflect.Struct) {
			continue
		}
		tag := f.Tag.Get("json")
		parts := strings.Split(tag, ",")
		if len(parts) > 1 && strings.Contains(","+strings.Join(parts[1:], ",")+",", ",string,") {
			return fmt.Errorf("unsupported JSON string tag on %s", f.Name)
		}
		if parts[0] == "-" {
			continue
		}
		if f.Anonymous && parts[0] == "" && x.Kind() == reflect.Struct {
			if err := fields(w, x, first); err != nil {
				return err
			}
			continue
		}
		name := parts[0]
		if name == "" {
			name = f.Name
		}
		if len(parts) > 1 && strings.Contains(","+strings.Join(parts[1:], ",")+",", ",omitempty,") && empty(x) {
			continue
		}
		if !*first {
			if err := write(w, ","); err != nil {
				return err
			}
		}
		*first = false
		if err := str(w, name); err != nil {
			return err
		}
		if err := write(w, ":"); err != nil {
			return err
		}
		if err := encode(w, x); err != nil {
			return err
		}
	}
	return nil
}
func empty(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.Array, reflect.Map, reflect.Slice, reflect.String:
		return v.Len() == 0
	case reflect.Bool, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Float32, reflect.Float64, reflect.Interface, reflect.Pointer:
		return v.IsZero()
	}
	return false
}
