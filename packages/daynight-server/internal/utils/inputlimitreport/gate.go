package inputlimitreport

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"strings"
	"time"
	"unicode"
)

// DatabaseIdentity must be collected independently from the database used for
// the planned activation, not copied from the report being checked.
type DatabaseIdentity struct {
	Host             string            `json:"Host"`
	Port             string            `json:"Port"`
	ServerAddress    string            `json:"ServerAddress"`
	ServerPort       string            `json:"ServerPort"`
	SystemIdentifier string            `json:"SystemIdentifier"`
	Database         string            `json:"Database"`
	DatabaseOID      string            `json:"DatabaseOID"`
	Schema           string            `json:"Schema"`
	Snapshot         string            `json:"Snapshot"`
	Relations        map[string]string `json:"Relations"`
	ObservedAt       time.Time         `json:"ObservedAt"`
}

// Header identifies the binary, policies, database and snapshot inspected.
type Header struct {
	Type           string           `json:"type"`
	SourceSHA      string           `json:"sourceSha"`
	SourceModified *bool            `json:"sourceModified"`
	PolicySHA      string           `json:"policySha"`
	SpecSHA        string           `json:"specSha"`
	PolicyVersion  string           `json:"policyVersion"`
	StorageRootSHA string           `json:"storageRootSha"`
	Identity       DatabaseIdentity `json:"identity"`
}

// Summary is the terminal record of a report. Counts covers each inspected
// resource kind, including kinds for which no records existed.
type Summary struct {
	Type          string           `json:"type"`
	Complete      bool             `json:"complete"`
	Clear         bool             `json:"clear"`
	Findings      int64            `json:"findings"`
	Indeterminate int64            `json:"indeterminate"`
	Counts        map[string]int64 `json:"counts"`
}

// GateContext contains independently acquired deployment facts. WindowStart is
// the start of the still-continuous writer-stopped window; Now is the time of
// this check. RequiredKinds is the complete expected inspection scope.
// Matching fields do not authenticate the report or prove writers were stopped:
// the caller must establish trusted report custody and the writer-stop window.
type GateContext struct {
	SourceSHA, PolicySHA, SpecSHA, PolicyVersion, StorageRootSHA string
	Database                                                     DatabaseIdentity
	WindowStart, Now                                             time.Time
	RequiredKinds                                                []string
}

var ErrGate = errors.New("report cannot establish activation readiness")

func validSHA(s string, lengths ...int) bool {
	validLength := false
	for _, n := range lengths {
		validLength = validLength || len(s) == n
	}
	if !validLength {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func validDatabase(d DatabaseIdentity) bool {
	if d.Host == "" || d.Port == "" || d.ServerAddress == "" || d.ServerPort == "" || d.SystemIdentifier == "" || d.Database == "" || d.DatabaseOID == "" || d.Schema == "" || len(d.Relations) == 0 {
		return false
	}
	for k, v := range d.Relations {
		if k == "" || v == "" {
			return false
		}
	}
	return true
}

// VerifyClear checks a trusted, complete JSONL report against independently
// obtained deployment facts. It rejects findings, missing scope/counts,
// ambiguous duplicate keys, partial records, and stale or mismatched identity.
func VerifyClear(src io.Reader, expected GateContext) error {
	fail := func(why string) error { return fmt.Errorf("%w: %s", ErrGate, why) }
	if !validSHA(expected.SourceSHA, 40, 64) || !validSHA(expected.PolicySHA, 64) || !validSHA(expected.SpecSHA, 64) || !validSHA(expected.StorageRootSHA, 64) || expected.PolicyVersion == "" || !validDatabase(expected.Database) || expected.WindowStart.IsZero() || expected.Now.IsZero() || expected.Now.Before(expected.WindowStart) || len(expected.RequiredKinds) == 0 {
		return fail("invalid deployment context")
	}
	r := bufio.NewReaderSize(src, MaxRecordBytes+1)
	var total int64
	var header Header
	var summary Summary
	var headerSeen, summarySeen bool
	for {
		line, err := r.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			return fail("record budget exceeded")
		}
		if err == io.EOF && len(line) == 0 {
			break
		}
		if err != nil {
			if err == io.EOF {
				return fail("unterminated record")
			}
			return fmt.Errorf("%w: read report: %w", ErrGate, err)
		}
		total += int64(len(line))
		if total > MaxReportBytes || validateRecord(line[:len(line)-1], MaxRecordBytes) != nil || !uniqueJSONKeys(line) {
			return fail("invalid or oversized record")
		}
		if summarySeen {
			return fail("record after summary")
		}
		var kind struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(line, &kind) != nil {
			return fail("invalid record")
		}
		switch kind.Type {
		case "header":
			if headerSeen || !canonicalObjectKeys(line, "type", "sourceSha", "sourceModified", "policySha", "specSha", "policyVersion", "storageRootSha", "identity") || !canonicalIdentity(line) || json.Unmarshal(line, &header) != nil {
				return fail("invalid header")
			}
			headerSeen = true
		case "summary":
			var required struct {
				Complete      *bool  `json:"complete"`
				Clear         *bool  `json:"clear"`
				Findings      *int64 `json:"findings"`
				Indeterminate *int64 `json:"indeterminate"`
			}
			if !headerSeen || !canonicalSummary(line) || json.Unmarshal(line, &required) != nil || required.Complete == nil || required.Clear == nil || required.Findings == nil || required.Indeterminate == nil || json.Unmarshal(line, &summary) != nil {
				return fail("invalid summary")
			}
			summarySeen = true
		default:
			return fail("report contains findings or unknown records")
		}
	}
	if !headerSeen || !summarySeen || !summary.Complete || !summary.Clear || summary.Findings != 0 || summary.Indeterminate != 0 {
		return fail("report is not complete and clear")
	}
	for _, kind := range expected.RequiredKinds {
		count, ok := summary.Counts[kind]
		if kind == "" || !ok || count < 0 {
			return fail("inspection scope incomplete")
		}
	}
	for _, count := range summary.Counts {
		if count < 0 {
			return fail("invalid count")
		}
	}
	a, b := header.Identity, expected.Database
	if header.SourceModified == nil || *header.SourceModified || header.SourceSHA != expected.SourceSHA || header.PolicySHA != expected.PolicySHA || header.SpecSHA != expected.SpecSHA || header.PolicyVersion != expected.PolicyVersion || header.StorageRootSHA != expected.StorageRootSHA || a.Host != b.Host || a.Port != b.Port || a.ServerAddress != b.ServerAddress || a.ServerPort != b.ServerPort || a.SystemIdentifier != b.SystemIdentifier || a.Database != b.Database || a.DatabaseOID != b.DatabaseOID || a.Schema != b.Schema || !maps.Equal(a.Relations, b.Relations) || a.Snapshot == "" || a.ObservedAt.IsZero() || a.ObservedAt.Before(expected.WindowStart) || a.ObservedAt.After(expected.Now) {
		return fail("identity or inspection window mismatch")
	}
	return nil
}

// uniqueJSONKeys prevents ambiguous interpretations of identity and completion.
func uniqueJSONKeys(data []byte) bool {
	d := json.NewDecoder(bytes.NewReader(data))
	var walk func() bool
	walk = func() bool {
		t, err := d.Token()
		if err != nil {
			return false
		}
		delim, ok := t.(json.Delim)
		if !ok {
			return true
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				k, err := d.Token()
				key, ok := k.(string)
				folded := foldKey(key)
				if err != nil || !ok || seen[folded] {
					return false
				}
				seen[folded] = true
				if !walk() {
					return false
				}
			}
			end, err := d.Token()
			return err == nil && end == json.Delim('}')
		case '[':
			for d.More() {
				if !walk() {
					return false
				}
			}
			end, err := d.Token()
			return err == nil && end == json.Delim(']')
		default:
			return false
		}
	}
	return walk() && strings.TrimSpace(string(data)) != ""
}

// Go's JSON decoder matches struct fields with Unicode simple case folding.
// Normalize each fold cycle so aliases are detected even outside ASCII.
func foldKey(key string) string {
	var b strings.Builder
	for _, r := range key {
		lowest := r
		for next := unicode.SimpleFold(r); next != r; next = unicode.SimpleFold(next) {
			if next < lowest {
				lowest = next
			}
		}
		b.WriteRune(lowest)
	}
	return b.String()
}

// Reject case aliases for schema names even if the canonical key is absent.
// Other keys remain available for forward-compatible, non-schema metadata.
func canonicalObjectKeys(data []byte, fields ...string) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil || object == nil {
		return false
	}
	for key := range object {
		for _, field := range fields {
			if key != field && strings.EqualFold(key, field) {
				return false
			}
		}
	}
	return true
}

func canonicalIdentity(data []byte) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil {
		return false
	}
	return canonicalObjectKeys(object["identity"], "Host", "Port", "ServerAddress", "ServerPort", "SystemIdentifier", "Database", "DatabaseOID", "Schema", "Snapshot", "Relations", "ObservedAt")
}

func canonicalSummary(data []byte) bool {
	return canonicalObjectKeys(data, "type", "complete", "clear", "counts", "findings", "indeterminate", "reason", "status")
}
