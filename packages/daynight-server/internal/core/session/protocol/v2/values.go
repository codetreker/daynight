package v2

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/netip"
	"net/url"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Error exposes stable protocol failures without implying authorization or delivery.
type Error struct{ Code string }

func (e *Error) Error() string  { return "invalid Daynight Session v2 value: " + e.Code }
func invalid(code string) error { return &Error{Code: code} }
func SelectProtocol(selection *string) (string, error) {
	if selection == nil {
		return "daynight.session.v1", nil
	}
	if *selection == Protocol || *selection == "daynight.session.v1" {
		return *selection, nil
	}
	return "", invalid("unsupported_protocol")
}
func HashBytes(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

// CanonicalJSON uses sorted object keys, compact safe integers and unescaped
// printable Unicode. It is not the archive body's identity: hash its original bytes.
func CanonicalJSON(value any) ([]byte, error) {
	if !validProducerStrings(reflect.ValueOf(value), 0) {
		return nil, invalid("invalid_payload")
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	v, err := strictJSON(raw)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err = writeCanonical(&out, v); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// encoding/json substitutes invalid UTF-8 in Go strings. Producers must fail
// before hashing instead of silently assigning an identity to replaced content.
func validProducerStrings(value reflect.Value, depth int) bool {
	if depth > 64 {
		return false
	}
	if !value.IsValid() {
		return true
	}
	switch value.Kind() {
	case reflect.String:
		return utf8.ValidString(value.String())
	case reflect.Interface:
		if !value.IsNil() {
			return validProducerStrings(value.Elem(), depth)
		}
	case reflect.Pointer:
		if !value.IsNil() {
			return validProducerStrings(value.Elem(), depth+1)
		}
	case reflect.Map:
		for _, key := range value.MapKeys() {
			if !validProducerStrings(key, depth+1) || !validProducerStrings(value.MapIndex(key), depth+1) {
				return false
			}
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < value.Len(); i++ {
			if !validProducerStrings(value.Index(i), depth+1) {
				return false
			}
		}
	case reflect.Struct:
		for i := 0; i < value.NumField(); i++ {
			if value.Type().Field(i).IsExported() && !validProducerStrings(value.Field(i), depth+1) {
				return false
			}
		}
	}
	return true
}
func writeCanonical(out *bytes.Buffer, value any) error {
	switch v := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		if v {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	case float64:
		if !integer(v, -9007199254740991, 9007199254740991) {
			return invalid("invalid_payload")
		}
		if v == 0 {
			out.WriteByte('0')
		} else {
			out.WriteString(strconv.FormatFloat(v, 'f', 0, 64))
		}
	case string:
		out.WriteString(quoteString(v))
	case []any:
		out.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := writeCanonical(out, item); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				out.WriteByte(',')
			}
			out.WriteString(quoteString(key))
			out.WriteByte(':')
			if err := writeCanonical(out, v[key]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		return invalid("invalid_payload")
	}
	return nil
}
func quoteString(value string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 32 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
func strictJSON(data []byte) (any, error) {
	if !validUnicode(data) {
		return nil, invalid("invalid_payload")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	value, err := readJSON(d, 0)
	if err != nil {
		return nil, invalid("invalid_payload")
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, invalid("invalid_payload")
	}
	return value, nil
}
func readJSON(d *json.Decoder, depth int) (any, error) {
	if depth > 64 {
		return nil, invalid("invalid_payload")
	}
	token, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch v := token.(type) {
	case json.Delim:
		if v == '{' {
			obj := map[string]any{}
			for d.More() {
				keyToken, e := d.Token()
				if e != nil {
					return nil, e
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, invalid("invalid_payload")
				}
				if _, exists := obj[key]; exists {
					return nil, invalid("invalid_payload")
				}
				item, e := readJSON(d, depth+1)
				if e != nil {
					return nil, e
				}
				obj[key] = item
			}
			end, e := d.Token()
			if e != nil || end != json.Delim('}') {
				return nil, invalid("invalid_payload")
			}
			return obj, nil
		}
		if v == '[' {
			a := []any{}
			for d.More() {
				item, e := readJSON(d, depth+1)
				if e != nil {
					return nil, e
				}
				a = append(a, item)
			}
			end, e := d.Token()
			if e != nil || end != json.Delim(']') {
				return nil, invalid("invalid_payload")
			}
			return a, nil
		}
		return nil, invalid("invalid_payload")
	case json.Number:
		n, e := v.Float64()
		if e != nil || math.IsInf(n, 0) || math.IsNaN(n) {
			return nil, invalid("invalid_payload")
		}
		return n, nil
	default:
		return token, nil
	}
}
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
		first, e := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if e != nil {
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
		second, e := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
		if e != nil || second < 0xdc00 || second > 0xdfff {
			return false
		}
		i += 6
	}
	return true
}

type check func(any) bool
type fields map[string]check

func object(v any, schema fields) bool {
	m, ok := v.(map[string]any)
	if !ok || len(m) != len(schema) {
		return false
	}
	for k, valid := range schema {
		item, exists := m[k]
		if !exists || !valid(item) {
			return false
		}
	}
	return true
}
func nested(schema fields) check { return func(v any) bool { return object(v, schema) } }
func nullable(valid check) check { return func(v any) bool { return v == nil || valid(v) } }
func boolean(v any) bool         { _, ok := v.(bool); return ok }
func literal(want any) check     { return func(v any) bool { return reflect.DeepEqual(v, want) } }
func enums(values ...string) check {
	return func(v any) bool {
		s, ok := v.(string)
		if !ok {
			return false
		}
		for _, x := range values {
			if s == x {
				return true
			}
		}
		return false
	}
}
func stringAt(v any) string      { s, _ := v.(string); return s }
func mapAt(v any) map[string]any { m, _ := v.(map[string]any); return m }
func integer(v any, min, max float64) bool {
	n, ok := v.(float64)
	return ok && n >= min && n <= max && math.Trunc(n) == n
}
func boundedInt(min, max float64) check { return func(v any) bool { return integer(v, min, max) } }

var uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var hashRE = regexp.MustCompile(`^[0-9a-f]{64}$`)
var sequenceRE = regexp.MustCompile(`^(0|[1-9][0-9]{0,18})$`)
var timestampRE = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$`)
var colorRE = regexp.MustCompile(`^#[0-9a-f]{6}$`)

func uuid(v any) bool { return uuidRE.MatchString(stringAt(v)) }
func hash(v any) bool { return hashRE.MatchString(stringAt(v)) }
func decimal(v any) bool {
	s := stringAt(v)
	if !sequenceRE.MatchString(s) {
		return false
	}
	_, e := strconv.ParseInt(s, 10, 64)
	return e == nil
}
func positive(v any) bool         { return decimal(v) && v != "0" }
func decimalValue(v string) int64 { n, _ := strconv.ParseInt(v, 10, 64); return n }
func native(v any) bool {
	s, ok := v.(string)
	return ok && len(s) > 0 && strings.TrimFunc(s, func(r rune) bool { return unicode.IsSpace(r) || r == 0xfeff }) != "" && len(s) <= 256 && utf8.ValidString(s) && strings.IndexFunc(s, unicode.IsControl) < 0
}
func timestamp(v any) bool {
	s := stringAt(v)
	if !timestampRE.MatchString(s) {
		return false
	}
	_, e := time.Parse(time.RFC3339Nano, s)
	return e == nil
}
func timeValue(v string) time.Time { t, _ := time.Parse(time.RFC3339Nano, v); return t }
func origin(v any) bool {
	s := stringAt(v)
	if len(s) == 0 || len(s) > 2048 {
		return false
	}
	u, e := url.Parse(s)
	if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || s != u.Scheme+"://"+u.Host || strings.ToLower(u.Host) != u.Host {
		return false
	}
	port := u.Port()
	if strings.HasSuffix(u.Host, ":") {
		return false
	}
	if port != "" {
		n, e := strconv.ParseUint(port, 10, 16)
		if e != nil || strconv.FormatUint(n, 10) != port || u.Scheme == "http" && n == 80 || u.Scheme == "https" && n == 443 {
			return false
		}
	}
	host := u.Hostname()
	if strings.HasPrefix(u.Host, "[") {
		ip, e := netip.ParseAddr(host)
		return e == nil && ip.Is6() && ip.Zone() == "" && canonicalIPv6(ip) == host
	}
	if !regexp.MustCompile(`^[a-z0-9._-]+$`).MatchString(host) {
		return false
	}
	// WHATWG URL parsing treats a numeric final label as an IPv4 candidate;
	// only the canonical four-octet spelling can survive origin equality.
	labels := strings.Split(strings.TrimSuffix(host, "."), ".")
	last := labels[len(labels)-1]
	numeric := regexp.MustCompile(`^[0-9]+$|^0x[0-9a-f]*$`).MatchString(last)
	if numeric {
		ip, e := netip.ParseAddr(host)
		return e == nil && ip.Is4() && ip.String() == host
	}
	return true
}
func canonicalIPv6(ip netip.Addr) string {
	bytes := ip.As16()
	parts := make([]string, 8)
	longestStart, longestCount := -1, 1
	for i := 0; i < 8; i++ {
		parts[i] = strconv.FormatUint(uint64(bytes[i*2])<<8|uint64(bytes[i*2+1]), 16)
	}
	for i := 0; i < 8; {
		if parts[i] != "0" {
			i++
			continue
		}
		start := i
		for i < 8 && parts[i] == "0" {
			i++
		}
		if i-start > longestCount {
			longestStart, longestCount = start, i-start
		}
	}
	if longestStart < 0 {
		return strings.Join(parts, ":")
	}
	return strings.Join(parts[:longestStart], ":") + "::" + strings.Join(parts[longestStart+longestCount:], ":")
}

func arrayOf(valid check, min, max int, unique string) check {
	return func(v any) bool {
		a, ok := v.([]any)
		if !ok || len(a) < min || len(a) > max {
			return false
		}
		seen := map[string]bool{}
		for _, item := range a {
			if !valid(item) {
				return false
			}
			if unique != "" {
				key := stringAt(item)
				if unique != "$" {
					key = stringAt(mapAt(item)[unique])
				}
				if seen[key] {
					return false
				}
				seen[key] = true
			}
		}
		return true
	}
}
func decodeValue[T any](v any) (T, error) {
	var out T
	b, e := CanonicalJSON(v)
	if e == nil {
		e = json.Unmarshal(b, &out)
	}
	return out, e
}

var errorCode = enums("permission_denied", "stale_fence", "target_changed", "lease_expired", "input_busy", "automation_suspended", "unsupported_protocol", "unsupported_content_kind", "input_unknown", "recording_limit", "source_corrupt", "stop_unknown", "archive_pending", "recording_not_enabled", "ended_before_first_sample", "upload_failed", "invalid_payload")
var unavailableReason = enums("recording_not_enabled", "ended_before_first_sample")
var completeness = enums("complete", "partial")
