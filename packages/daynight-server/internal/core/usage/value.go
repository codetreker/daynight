package usage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

const Protocol = "daynight.usage.v1"

var decimal = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
var timestamp = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$`)

func Fault(code string) error { return &model.UsageFault{Code: code} }
func UUID(s string) bool      { u, e := uuid.Parse(s); return e == nil && u.String() == s }
func Decimal(s string, maxDigits int) bool {
	return decimal.MatchString(s) && (maxDigits == 0 || len(s) <= maxDigits)
}
func Sequence(s string, zero bool) bool {
	if !Decimal(s, 19) || !zero && s == "0" {
		return false
	}
	_, e := strconv.ParseInt(s, 10, 64)
	return e == nil
}
func Next(s string) (string, error) {
	n, e := strconv.ParseInt(s, 10, 64)
	if e != nil || n < 0 || n == 9223372036854775807 {
		return "", Fault("revision_overflow")
	}
	return strconv.FormatInt(n+1, 10), nil
}
func Timestamp(s string) bool {
	t, e := time.Parse(time.RFC3339Nano, s)
	return e == nil && timestamp.MatchString(s) && t.Nanosecond()%1000 == 0
}
func Text(s string, limit int) bool {
	return s != "" && len(s) <= limit && utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}
func Ptr(s string) *string { return &s }
func Value(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Canonical implements the RFC8785 subset admitted by this protocol: objects,
// arrays, strings, booleans and null. No binary floating-point numbers enter it.
func Canonical(v any) ([]byte, error) {
	raw, e := json.Marshal(v)
	if e != nil {
		return nil, e
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var normalized any
	if e = d.Decode(&normalized); e != nil {
		return nil, e
	}
	var b bytes.Buffer
	if e = canonical(&b, normalized); e != nil {
		return nil, e
	}
	return b.Bytes(), nil
}
func canonical(b *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(x))
	case string:
		b.WriteByte('"')
		for _, r := range x {
			switch r {
			case '"', '\\':
				b.WriteByte('\\')
				b.WriteRune(r)
			case '\b':
				b.WriteString(`\b`)
			case '\t':
				b.WriteString(`\t`)
			case '\n':
				b.WriteString(`\n`)
			case '\f':
				b.WriteString(`\f`)
			case '\r':
				b.WriteString(`\r`)
			default:
				if r < 0x20 {
					const h = "0123456789abcdef"
					b.WriteString(`\u00`)
					b.WriteByte(h[byte(r)>>4])
					b.WriteByte(h[byte(r)&15])
				} else {
					b.WriteRune(r)
				}
			}
		}
		b.WriteByte('"')
	case []any:
		b.WriteByte('[')
		for i, a := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if e := canonical(b, a); e != nil {
				return e
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			a, c := utf16.Encode([]rune(keys[i])), utf16.Encode([]rune(keys[j]))
			for n := 0; n < len(a) && n < len(c); n++ {
				if a[n] != c[n] {
					return a[n] < c[n]
				}
			}
			return len(a) < len(c)
		})
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			_ = canonical(b, k)
			b.WriteByte(':')
			if e := canonical(b, x[k]); e != nil {
				return e
			}
		}
		b.WriteByte('}')
	default:
		return Fault("invalid_canonical_value")
	}
	return nil
}
func Hash(v any) (string, error) {
	b, e := Canonical(v)
	if e != nil {
		return "", e
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}
func SortedReasons(r []string) ([]string, error) {
	if r == nil || len(r) > 16 {
		return nil, Fault("invalid_measurement")
	}
	out := append([]string{}, r...)
	sort.Strings(out)
	for i, s := range out {
		if !reasonSet[s] || i > 0 && out[i-1] == s {
			return nil, Fault("invalid_measurement")
		}
	}
	return out, nil
}

var reasonSet = func() map[string]bool {
	m := map[string]bool{}
	for _, s := range strings.Split("historical_no_data,registration_missing,provider_unsupported,profile_unverified,native_recovery_gap,missing_final,subagent_scope_unknown,external_review_unobserved,model_unknown,source_conflict,inclusion_parent_missing,attribution_unknown,local_capacity_exceeded,local_storage_failed,upload_expired,permission_revoked,collector_failed,scope_restricted,native_integer_unrepresentable,input_cache_semantics_unknown", ",") {
		m[s] = true
	}
	return m
}()

// MergeReasons keeps the protocol budget without displacing fixed profile
// limits or server-derived lifecycle, attribution, and safety failures.
func MergeReasons(a []string, b ...string) []string {
	m := map[string]bool{}
	for _, s := range append(append([]string{}, a...), b...) {
		m[s] = true
	}
	out := make([]string, 0, len(m))
	for s := range m {
		out = append(out, s)
	}
	if len(out) > 16 {
		sort.Slice(out, func(i, j int) bool {
			if protectedReasons[out[i]] != protectedReasons[out[j]] {
				return protectedReasons[out[i]]
			}
			return out[i] < out[j]
		})
		out = out[:16]
	}
	sort.Strings(out)
	return out
}

var protectedReasons = func() map[string]bool {
	m := map[string]bool{}
	for _, s := range strings.Split("source_conflict,profile_unverified,provider_unsupported,native_recovery_gap,input_cache_semantics_unknown,subagent_scope_unknown,missing_final,upload_expired,permission_revoked,collector_failed,attribution_unknown,inclusion_parent_missing,local_capacity_exceeded,local_storage_failed,native_integer_unrepresentable,scope_restricted", ",") {
		m[s] = true
	}
	return m
}()

func Metrics(m model.UsageMetrics, disjoint bool) error {
	values := []*string{m.Input, m.Output, m.CacheRead, m.CacheWrite, m.Reasoning, m.Total, m.ProviderTotal}
	for _, v := range values {
		if v != nil && !Decimal(*v, 38) {
			return Fault("invalid_measurement")
		}
	}
	less := func(a, b *string) bool {
		if a == nil || b == nil {
			return true
		}
		x, _ := new(big.Int).SetString(*a, 10)
		y, _ := new(big.Int).SetString(*b, 10)
		return x.Cmp(y) <= 0
	}
	if !less(m.CacheRead, m.Input) || !less(m.CacheWrite, m.Input) || !less(m.Reasoning, m.Output) {
		return Fault("invalid_measurement")
	}
	sum := func(a, b *string) *big.Int {
		x, _ := new(big.Int).SetString(*a, 10)
		y, _ := new(big.Int).SetString(*b, 10)
		return x.Add(x, y)
	}
	if disjoint && m.Input != nil && m.CacheRead != nil && m.CacheWrite != nil {
		n, _ := new(big.Int).SetString(*m.Input, 10)
		if sum(m.CacheRead, m.CacheWrite).Cmp(n) > 0 {
			return Fault("invalid_measurement")
		}
	}
	if m.Input != nil && m.Output != nil && m.Total != nil {
		n, _ := new(big.Int).SetString(*m.Total, 10)
		if sum(m.Input, m.Output).Cmp(n) != 0 {
			return Fault("invalid_measurement")
		}
	}
	return nil
}
func Equal(a, b any) bool { return reflect.DeepEqual(a, b) }
