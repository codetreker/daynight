package mcp

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestObjectFieldsLocatesExactValues(t *testing.T) {
	raw := []byte(" { \n \"name\" \t: \r\n {\"nested\": [1,2]}, \"other\": true, \"name\": null } ")
	fields, err := objectFields(raw, "name")
	if err != nil || len(fields) != 2 || !bytes.Equal(raw[fields[0][0]:fields[0][1]], []byte(`{"nested": [1,2]}`)) || !bytes.Equal(raw[fields[1][0]:fields[1][1]], []byte("null")) {
		t.Fatalf("fields=%v err=%v", fields, err)
	}
	fields, err = objectFields(raw, "absent")
	if err != nil || len(fields) != 0 {
		t.Fatalf("absent field: %v, %v", fields, err)
	}
}

func TestObjectFieldsRejectsMalformedObjects(t *testing.T) {
	for _, raw := range []string{
		"", "null", "[]", `{1:2}`, `{"name"`, `{"name" 1}`, `{"name":`, `{"name":}`, `{"name":[}`, `{"name":1`,
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := objectFields([]byte(raw), "name"); err == nil {
				t.Fatalf("malformed object accepted: %q", raw)
			}
		})
	}
}

func TestBatchIDCorrelationPreservesClientMetadata(t *testing.T) {
	for name, meta := range map[string]string{
		"absent":          "",
		"null":            `,"_meta":null`,
		"empty":           `,"_meta":{}`,
		"object":          `,"_meta":{"user":{"nested":"value"},"number":9007199254740991}`,
		"duplicates":      `,"_meta":{"first":1},"_meta":{"second":2}`,
		"duplicate reset": `,"_meta":{"first":1},"_meta":null`,
	} {
		t.Run(name, func(t *testing.T) {
			body := []byte(`[{"jsonrpc":"2.0","id":"one","method":"tools/call","params":{"name":"task_update","arguments":{"title":"<\\\""}` + meta + `}}]`)
			transformed, single, key, ids := prepareRPCIDs(body)
			if single != nil || key == "" || len(ids) != 1 {
				t.Fatalf("missing correlation: %s", transformed)
			}
			decode := func(raw []byte) sdk.CallToolParamsRaw {
				t.Helper()
				var batch []json.RawMessage
				if err := json.Unmarshal(raw, &batch); err != nil {
					t.Fatal(err)
				}
				msg, err := jsonrpc.DecodeMessage(batch[0])
				if err != nil {
					t.Fatal(err)
				}
				var result sdk.CallToolParamsRaw
				if err := json.Unmarshal(msg.(*jsonrpc.Request).Params, &result); err != nil {
					t.Fatal(err)
				}
				return result
			}
			before, after := decode(body), decode(transformed)
			token, ok := after.GetMeta()[key].(string)
			if !ok || ids[token].id != "one" {
				t.Fatalf("incorrect token: %#v", after.GetMeta())
			}
			delete(after.GetMeta(), key)
			if ids[token].restoreNil {
				after.SetMeta(nil)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("metadata changed: before=%#v after=%#v", before, after)
			}
		})
	}
}

func TestMaximumBatchInputRemainsBounded(t *testing.T) {
	prefix := `[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_update","arguments":{},"padding":"`
	suffix := `"}}]`
	body := []byte(prefix + strings.Repeat("x", transport.MaxMCPJSONBodyBytes-len(prefix)-len(suffix)) + suffix)
	got, _, key, ids := prepareRPCIDs(body)
	if key == "" || len(ids) != 1 || len(got) <= len(body) || len(got) > 4*transport.MaxMCPJSONBodyBytes || !json.Valid(got) {
		t.Fatalf("maximum batch transformation: input=%d output=%d ids=%d", len(body), len(got), len(ids))
	}
}

func TestBatchInvalidMetadataIsNotRewritten(t *testing.T) {
	for _, value := range []string{`"invalid"`, `[]`, `123`} {
		body := []byte(`[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_update","arguments":{},"_meta":` + value + `}}]`)
		got, _, key, ids := prepareRPCIDs(body)
		if string(got) != string(body) || key != "" || ids != nil {
			t.Fatalf("invalid metadata changed: %s", got)
		}
	}
}
