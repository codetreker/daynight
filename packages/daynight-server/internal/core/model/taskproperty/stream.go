package taskproperty

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

// streamDecoder keeps no raw input value. The bounded prefix is sufficient for
// the existing schema validators; large free-text fields are represented by a
// valid placeholder and independently recorded as exceeding the output budget.
type streamDecoder struct {
	ctx        context.Context
	reader     *bufio.Reader
	max        int64
	overflow   bool
	badUnicode bool
	read       int64
	captured   int64
	ioErr      error
}

func (d *streamDecoder) byte() (byte, error) {
	d.read++
	if d.read%8192 < 4 {
		if err := d.ctx.Err(); err != nil {
			return 0, err
		}
	}
	b, err := d.reader.ReadByte()
	if err != nil && err != io.EOF {
		d.ioErr = err
	}
	return b, err
}
func (d *streamDecoder) significant() (byte, error) {
	for {
		b, err := d.byte()
		if err != nil {
			return 0, err
		}
		if b != ' ' && b != '\t' && b != '\r' && b != '\n' {
			return b, nil
		}
	}
}
func (d *streamDecoder) hex4() (rune, error) {
	var n rune
	for range 4 {
		b, e := d.byte()
		if e != nil {
			return 0, e
		}
		n <<= 4
		switch {
		case b >= '0' && b <= '9':
			n += rune(b - '0')
		case b >= 'a' && b <= 'f':
			n += rune(b - 'a' + 10)
		case b >= 'A' && b <= 'F':
			n += rune(b - 'A' + 10)
		default:
			return 0, errors.New("invalid Unicode escape")
		}
	}
	return n, nil
}
func (d *streamDecoder) quoted(key string) (string, bool, error) {
	var out strings.Builder
	cap := d.max - d.captured + 1
	if key == "" {
		cap = 512
	}
	if cap < 512 {
		cap = 512
	}
	var length, escapedLength int64
	var nonspace, nul, clipped bool
	// Worker claimedAt normalizes through time.Parse and may contain an
	// arbitrarily long fraction. Retain its first nine digits and its suffix.
	fraction, fractionDigits := false, 0
	appendRune := func(r rune) {
		if key == "claimedAt" {
			if !fraction && length == 19 && (r == '.' || r == ',') {
				fraction = true
			} else if fraction && r >= '0' && r <= '9' {
				fractionDigits++
				if fractionDigits > 9 {
					return
				}
			} else if fraction && fractionDigits > 0 {
				fraction = false
			}
		}
		length += int64(utf8.RuneLen(r))
		switch r {
		case '"', '\\', '\b', '\f', '\n', '\r', '\t':
			escapedLength += 2
		case '<', '>', '&', '\u2028', '\u2029':
			escapedLength += 6
		default:
			if r < 0x20 {
				escapedLength += 6
			} else {
				escapedLength += int64(utf8.RuneLen(r))
			}
		}
		if !unicode.IsSpace(r) {
			nonspace = true
		}
		if r == 0 {
			nul = true
		}
		if escapedLength <= cap {
			out.WriteRune(r)
		} else {
			clipped = true
		}
	}
	for {
		b, err := d.byte()
		if err != nil {
			return "", false, err
		}
		if b == '"' {
			break
		}
		if b < 0x20 {
			return "", false, errors.New("unescaped control byte")
		}
		if b == '\\' {
			e, err := d.byte()
			if err != nil {
				return "", false, err
			}
			switch e {
			case '"', '\\', '/':
				appendRune(rune(e))
			case 'b':
				appendRune('\b')
			case 'f':
				appendRune('\f')
			case 'n':
				appendRune('\n')
			case 'r':
				appendRune('\r')
			case 't':
				appendRune('\t')
			case 'u':
				r, err := d.hex4()
				if err != nil {
					return "", false, err
				}
				if r >= 0xd800 && r <= 0xdbff {
					peek, _ := d.reader.Peek(6)
					if len(peek) == 6 && peek[0] == '\\' && peek[1] == 'u' {
						value, err := strconv.ParseUint(string(peek[2:]), 16, 16)
						if err == nil && value >= 0xdc00 && value <= 0xdfff {
							for range 6 {
								if _, err = d.byte(); err != nil {
									return "", false, err
								}
							}
							r = utf16.DecodeRune(r, rune(value))
						} else {
							r = utf8.RuneError
							d.badUnicode = true
						}
					} else {
						r = utf8.RuneError
						d.badUnicode = true
					}
				} else if r >= 0xdc00 && r <= 0xdfff {
					r = utf8.RuneError
					d.badUnicode = true
				}
				appendRune(r)
			default:
				return "", false, errors.New("invalid escape")
			}
		} else if b < utf8.RuneSelf {
			appendRune(rune(b))
		} else {
			if err := d.reader.UnreadByte(); err != nil {
				return "", false, err
			}
			r, n, err := d.reader.ReadRune()
			if err != nil {
				if err != io.EOF {
					d.ioErr = err
				}
				return "", false, err
			}
			d.read += int64(n - 1)
			if r == utf8.RuneError && n == 1 {
				d.badUnicode = true
			}
			appendRune(r)
		}
	}
	if clipped {
		// These stand-ins preserve worker text validation without retaining the
		// value. Other string validators reject the stand-in for an oversized ID,
		// enum or sequence.
		if nul {
			return "\x00", true, nil
		}
		if !nonspace {
			return " ", true, nil
		}
		return "oversized", true, nil
	}
	if key != "" {
		d.captured += escapedLength
	}
	return out.String(), false, nil
}

// stringValue returns a JSON string after validating and decoding it.
func (d *streamDecoder) stringValue(key string) ([]byte, error) {
	value, clipped, err := d.quoted(key)
	if err != nil {
		return nil, err
	}
	if clipped {
		d.overflow = true
	}
	return json.Marshal(value)
}

// schemaNode describes only the structural grammar; NormalizeValue applies the
// complete existing domain validation to the compact representation.
type schemaNode struct {
	fields   map[string]*schemaNode
	array    *schemaNode
	kind     byte
	nullable bool
}

var streamString = &schemaNode{kind: 's'}
var streamNullableString = &schemaNode{kind: 's', nullable: true}
var streamBoolean = &schemaNode{kind: 'b'}
var streamNumber = &schemaNode{kind: 'n'}
var streamWorker = &schemaNode{kind: 'o', fields: map[string]*schemaNode{
	"claimId": streamString, "state": streamString, "userId": streamString, "workerId": streamString,
	"machine":  {kind: 'o', fields: map[string]*schemaNode{"id": streamString, "name": streamString}},
	"platform": streamString, "agent": streamString, "agentControlMode": streamString, "worktreeId": streamString, "phase": streamString,
	"herdr":           {kind: 'o', nullable: true, fields: map[string]*schemaNode{"session": streamString, "workspaceId": streamString, "paneId": streamString}},
	"nativeSessionId": streamNullableString, "claimedAt": streamString,
}}
var streamStartup = &schemaNode{kind: 'o', fields: map[string]*schemaNode{
	"schemaVersion": streamNumber, "source": streamString, "sessionId": streamString, "claimId": streamString, "executionGeneration": streamString, "controllerInstanceId": streamString, "revision": streamString, "observedAt": streamString,
	"startup":  {kind: 'o', fields: map[string]*schemaNode{"state": streamString, "reasonCode": streamString}},
	"recovery": {kind: 'o', fields: map[string]*schemaNode{"state": streamString, "reasonCode": streamNullableString}},
}}
var streamPR = &schemaNode{kind: 'o', fields: map[string]*schemaNode{"url": streamString, "title": streamString}}

func (d *streamDecoder) literal(first byte, suffix string) error {
	for i := 0; i < len(suffix); i++ {
		b, e := d.byte()
		if e != nil {
			return e
		}
		if b != suffix[i] {
			return fmt.Errorf("invalid %c literal", first)
		}
	}
	return nil
}

// number compresses arbitrarily long numeric spellings to the only value the
// version schema accepts. A bounded significant prefix plus a sticky digit
// preserves float64 rounding, including values adjacent to one.
func (d *streamDecoder) number(first byte) ([]byte, error) {
	state := byte('i')
	negative, integerDigits, fractionDigits, exponentDigits := first == '-', int64(0), int64(0), int64(0)
	leadingZero, exponentNegative, sticky := false, false, false
	var significant strings.Builder
	var totalSignificant, exponent int64
	consumeDigit := func(b byte, fractional bool) {
		if fractional {
			fractionDigits++
		} else {
			integerDigits++
		}
		if significant.Len() != 0 || b != '0' {
			totalSignificant++
			if significant.Len() < 1024 {
				significant.WriteByte(b)
			} else if b != '0' {
				sticky = true
			}
		}
	}
	b := first
	if negative {
		var err error
		b, err = d.byte()
		if err != nil {
			return nil, err
		}
	}
	if b < '0' || b > '9' {
		return nil, errors.New("invalid number")
	}
	leadingZero = b == '0'
	consumeDigit(b, false)
	for {
		v, err := d.byte()
		if err != nil && err != io.EOF {
			return nil, err
		}
		if err == io.EOF {
			break
		}
		if v >= '0' && v <= '9' {
			switch state {
			case 'i':
				if leadingZero {
					return nil, errors.New("invalid leading zero")
				}
				consumeDigit(v, false)
			case 'f':
				consumeDigit(v, true)
			case 'e':
				exponentDigits++
				const exponentCeiling = int64(1 << 60)
				if exponent < exponentCeiling {
					if exponent > (exponentCeiling-int64(v-'0'))/10 {
						exponent = exponentCeiling
					} else {
						exponent = exponent*10 + int64(v-'0')
					}
				}
			}
			continue
		}
		if v == '.' && state == 'i' {
			state = 'f'
			continue
		}
		if (v == 'e' || v == 'E') && (state == 'i' || state == 'f') {
			if state == 'f' && fractionDigits == 0 {
				return nil, errors.New("missing fractional digits")
			}
			state = 'e'
			v, err = d.byte()
			if err != nil {
				return nil, err
			}
			if v == '+' || v == '-' {
				exponentNegative = v == '-'
			} else {
				if err = d.reader.UnreadByte(); err != nil {
					return nil, err
				}
			}
			continue
		}
		if v != ' ' && v != '\t' && v != '\r' && v != '\n' && v != ',' && v != '}' && v != ']' {
			return nil, errors.New("invalid number")
		}
		if err = d.reader.UnreadByte(); err != nil {
			return nil, err
		}
		break
	}
	if integerDigits == 0 || state == 'f' && fractionDigits == 0 || state == 'e' && exponentDigits == 0 {
		return nil, errors.New("incomplete number")
	}
	if negative || totalSignificant == 0 {
		return []byte("0"), nil
	}
	digits := significant.String()
	exponentValue := exponent
	if exponentNegative {
		exponentValue = -exponentValue
	}
	exponentValue += totalSignificant - int64(len(digits)) - fractionDigits
	if sticky {
		digits += "1"
		exponentValue--
	}
	value, err := strconv.ParseFloat(digits+"e"+strconv.FormatInt(exponentValue, 10), 64)
	if err == nil && value == 1 {
		return []byte("1"), nil
	}
	return []byte("0"), nil
}

func (d *streamDecoder) value(first byte, node *schemaNode, key string) ([]byte, error) {
	if first == 'n' {
		if err := d.literal(first, "ull"); err != nil {
			return nil, err
		}
		if !node.nullable {
			return nil, errors.New("null is not allowed")
		}
		return []byte("null"), nil
	}
	switch node.kind {
	case 's':
		if first != '"' {
			return nil, errors.New("expected string")
		}
		return d.stringValue(key)
	case 'b':
		if first == 't' {
			if e := d.literal(first, "rue"); e != nil {
				return nil, e
			}
			return []byte("true"), nil
		}
		if first == 'f' {
			if e := d.literal(first, "alse"); e != nil {
				return nil, e
			}
			return []byte("false"), nil
		}
		return nil, errors.New("expected boolean")
	case 'n':
		if first != '-' && (first < '0' || first > '9') {
			return nil, errors.New("expected number")
		}
		return d.number(first)
	case 'o':
		if first != '{' {
			return nil, errors.New("expected object")
		}
		var out bytes.Buffer
		out.WriteByte('{')
		seen := map[string]bool{}
		b, e := d.significant()
		if e != nil {
			return nil, e
		}
		if b == '}' {
			out.WriteByte('}')
			return out.Bytes(), nil
		}
		if err := d.reader.UnreadByte(); err != nil {
			return nil, err
		}
		for {
			b, e = d.significant()
			if e != nil {
				return nil, e
			}
			if b != '"' {
				return nil, errors.New("expected object key")
			}
			name, clipped, e := d.quoted("")
			if e != nil {
				return nil, e
			}
			child, ok := node.fields[name]
			if clipped || !ok || seen[name] {
				return nil, errors.New("unknown or duplicate object field")
			}
			seen[name] = true
			b, e = d.significant()
			if e != nil || b != ':' {
				return nil, errors.New("missing object colon")
			}
			b, e = d.significant()
			if e != nil {
				return nil, e
			}
			val, e := d.value(b, child, name)
			if e != nil {
				return nil, e
			}
			if out.Len() > 1 {
				out.WriteByte(',')
			}
			encoded, _ := json.Marshal(name)
			out.Write(encoded)
			out.WriteByte(':')
			out.Write(val)
			b, e = d.significant()
			if e != nil {
				return nil, e
			}
			if b == '}' {
				out.WriteByte('}')
				return out.Bytes(), nil
			}
			if b != ',' {
				return nil, errors.New("invalid object separator")
			}
		}
	default:
		return nil, errors.New("invalid schema")
	}
}

func NormalizeStream(ctx context.Context, name string, reader io.Reader, max int64) (json.RawMessage, error) {
	value, _, err := normalizeStream(ctx, name, reader, max, false, false)
	return value, err
}

// NormalizeStreamLegacy returns a validated compact worker summary for a claim
// omitted by the legacy projection. It retains the fields used for filtering.
func NormalizeStreamLegacy(ctx context.Context, name string, reader io.Reader, max int64) (json.RawMessage, bool, error) {
	return normalizeStream(ctx, name, reader, max, true, false)
}

// NormalizeWorkerSummary validates the entire worker value while retaining only
// the fields needed to identify and classify a claim.
func NormalizeWorkerSummary(ctx context.Context, reader io.Reader) (json.RawMessage, error) {
	value, _, err := normalizeStream(ctx, "worker", reader, 0, true, true)
	return value, err
}

func normalizeStream(ctx context.Context, name string, reader io.Reader, max int64, legacy, summaryOnly bool) (json.RawMessage, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if _, err := definition(name); err != nil {
		return nil, false, err
	}
	if max < 0 {
		return nil, false, fmt.Errorf("negative property budget")
	}
	d := &streamDecoder{ctx: ctx, reader: bufio.NewReader(reader), max: max}
	b, err := d.significant()
	if err != nil {
		if d.ioErr != nil {
			return nil, false, d.ioErr
		}
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		return nil, false, validation("properties."+name, "invalid JSON value", err)
	}
	var value []byte
	if name == "pullRequests" {
		if b != '[' {
			err = errors.New("expected array")
		} else {
			var out bytes.Buffer
			out.WriteByte('[')
			first := true
			b, err = d.significant()
			if err == nil && b != ']' {
				for {
					item, e := d.value(b, streamPR, "")
					if e != nil {
						err = e
						break
					}
					normalized, e := normalizePullRequests(append(append([]byte("["), item...), ']'))
					if e != nil {
						err = e
						break
					}
					extra := len(normalized) - 2
					if !first {
						extra++
					}
					if int64(out.Len()+extra+1) <= max {
						if !first {
							out.WriteByte(',')
						}
						out.Write(normalized[1 : len(normalized)-1])
						first = false
					} else {
						d.overflow = true
					}
					b, e = d.significant()
					if e != nil {
						err = e
						break
					}
					if b == ']' {
						break
					}
					if b != ',' {
						err = errors.New("invalid array separator")
						break
					}
					b, e = d.significant()
					if e != nil {
						err = e
						break
					}
				}
			}
			out.WriteByte(']')
			value = out.Bytes()
		}
	} else {
		node := streamBoolean
		if name == "worker" {
			node = streamWorker
		} else if name == "sessionStartup" {
			node = streamStartup
		}
		value, err = d.value(b, node, "")
	}
	if err == nil {
		_, err = d.significant()
		if err == io.EOF {
			err = nil
		} else if err == nil {
			err = errors.New("multiple JSON values")
		}
	}
	if err != nil {
		if d.ioErr != nil {
			return nil, false, d.ioErr
		}
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		return nil, false, validation("properties."+name, "invalid property value", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if name == "sessionStartup" && d.badUnicode {
		return nil, false, validation("properties."+name, "invalid Unicode", nil)
	}
	normalized, err := NormalizeValue(name, value)
	if err != nil {
		return nil, false, err
	}
	if legacy && name == "worker" {
		worker, err := decodeWorker(normalized)
		if err != nil {
			return nil, false, validation("properties.worker", "invalid property value", err)
		}
		compatible := worker.AgentControlMode == "" || worker.AgentControlMode == "herdr"
		compatible = compatible && (worker.Agent == "codex" || worker.Agent == "copilot")
		if !compatible || summaryOnly {
			worker.Machine.Name = "worker"
			if worker.Herdr != nil {
				worker.Herdr.Session, worker.Herdr.WorkspaceID, worker.Herdr.PaneID = "session", "workspace", "pane"
			}
			if worker.NativeSessionID != nil {
				value := "session"
				worker.NativeSessionID = &value
			}
			summary, err := EncodeWorker(worker)
			return summary, true, err
		}
	}
	if d.overflow || int64(len(normalized)) > max {
		return nil, false, &limit.Violation{Field: "properties." + name, Max: max, Actual: max + 1, Unit: "bytes", LowerBound: true}
	}
	return normalized, false, nil
}
