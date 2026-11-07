package webhook

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

const maxBody = 256 << 10

func uuidInput(v string) (string, error) {
	if webhookcore.CanonicalUUID(v) != nil {
		return "", httpx.InvalidInput("ID must be a canonical nonzero UUID")
	}
	return v, nil
}

// validUnicode rejects unpaired JSON UTF-16 escapes, which encoding/json would
// otherwise silently replace with U+FFFD before validation or fingerprinting.
func validUnicode(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	inString := false
	for i := 0; i < len(data); i++ {
		c := data[i]
		if !inString {
			if c == '"' {
				inString = true
			}
			continue
		}
		if c == '"' {
			inString = false
			continue
		}
		if c != '\\' {
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
		n, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if n >= 0xdc00 && n <= 0xdfff {
			return false
		}
		if n >= 0xd800 && n <= 0xdbff {
			if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}

func readBody(w http.ResponseWriter, r *http.Request, allowed ...string) (map[string]json.RawMessage, string, error) {
	if len(r.Header.Values("Content-Type")) != 1 {
		httpx.CloseUnreadBody(w, r)
		return nil, "", httpx.InvalidInput("exactly one Content-Type is required")
	}
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || len(params) > 1 || (len(params) == 1 && !strings.EqualFold(params["charset"], "utf-8")) {
		httpx.CloseUnreadBody(w, r)
		return nil, "", httpx.InvalidInput("Content-Type must be application/json with UTF-8 encoding")
	}
	body, err := httpx.ReadBody(w, r, maxBody, transport.JSONBodyReadTimeout)
	if err != nil {
		return nil, "", err
	}
	if !validUnicode(body) {
		return nil, "", httpx.InvalidInput("request body must contain valid Unicode")
	}
	fields, err := jsonobject.Decode(body, "request body", allowed...)
	if err != nil {
		return nil, "", httpx.InvalidInput(err.Error())
	}
	hash := sha256.Sum256(body)
	return fields, hex.EncodeToString(hash[:]), nil
}

func destinationInput(raw json.RawMessage) (*Destination, error) {
	fields, err := jsonobject.Decode(raw, "destination", "kind", "adapterVersion", "configuration")
	if err != nil {
		return nil, httpx.InvalidInput(err.Error())
	}
	kind, err := httpx.RequiredString(fields, "kind")
	if err != nil {
		return nil, err
	}
	version, err := httpx.RequiredString(fields, "adapterVersion")
	if err != nil {
		return nil, err
	}
	if kind != "http" || version != "1" {
		return nil, &model.Fault{Code: "destination_unsupported", Message: "Destination type or version is unsupported."}
	}
	config, err := jsonobject.Decode(fields["configuration"], "destination.configuration", "url")
	if err != nil {
		return nil, httpx.InvalidInput(err.Error())
	}
	value, err := httpx.RequiredString(config, "url")
	if err != nil {
		return nil, err
	}
	if _, err := webhookcore.ValidateURL(value); err != nil {
		return nil, httpx.InvalidInput("destination URL must be an HTTPS URL without userinfo or fragment and at most 4 KiB")
	}

	return &Destination{Kind: kind, AdapterVersion: version, URL: value}, nil
}

func mutationInput(fields map[string]json.RawMessage, digest, kind, endpoint string, p model.Principal) (Mutation, error) {
	m := Mutation{Kind: kind, EndpointID: endpoint, RequestSHA256: digest}
	var err error
	m.OperationID, err = httpx.RequiredString(fields, "operationId")
	if err != nil {
		return m, err
	}
	m.OperationID, err = uuidInput(m.OperationID)
	if err != nil {
		return m, err
	}
	m.ExpectedUserID, err = httpx.RequiredString(fields, "expectedUserId")
	if err != nil {
		return m, err
	}
	m.ExpectedUserID, err = uuidInput(m.ExpectedUserID)
	if err != nil {
		return m, err
	}
	if m.ExpectedUserID != p.UserID {
		return m, &model.Fault{Code: "identity_mismatch", Message: "The expected user does not match the authenticated user."}
	}
	m.IssuedAt, err = httpx.RequiredString(fields, "issuedAt")
	if err != nil {
		return m, err
	}
	if _, err = webhookcore.ParseIssuedAt(m.IssuedAt); err != nil {
		return m, httpx.InvalidInput("issuedAt must be a UTC RFC3339 timestamp")
	}

	if kind != "endpoint.create" {
		v, e := httpx.RequiredString(fields, "ifVersion")
		if e != nil {
			return m, e
		}
		m.IfVersion, e = webhookcore.ParseVersion(v)
		if e != nil {
			return m, httpx.InvalidInput("ifVersion must be a positive int64 decimal string")
		}

	}
	if kind == "endpoint.create" || kind == "endpoint.update" {
		m.Name, err = httpx.OptionalString(fields, "name")
		if err != nil {
			return m, err
		}
		if m.Name != nil {
			name, e := webhookcore.NormalizeName(*m.Name)
			if e != nil {
				return m, httpx.InvalidInput("name must contain 1 to 120 Unicode characters without controls")
			}
			m.Name = &name
		}

		m.Enabled, err = httpx.OptionalBool(fields, "enabled")
		if err != nil {
			return m, err
		}
		if raw, ok := fields["destination"]; ok {
			m.Destination, err = destinationInput(raw)
			if err != nil {
				return m, err
			}
		}
		if raw, ok := fields["subscriptions"]; ok {
			m.HasSubscriptions = true
			var items []json.RawMessage
			if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &items) != nil || len(items) != 0 {
				return m, httpx.InvalidInput("subscriptions must be empty")
			}
		}
		if _, ok := fields["confirmProjectIds"]; ok {
			return m, httpx.InvalidInput("subscription confirmation is unavailable")
		}
		if kind == "endpoint.create" && (m.Name == nil || m.Enabled == nil || m.Destination == nil || !m.HasSubscriptions) {
			return m, httpx.InvalidInput("name, enabled, destination and empty subscriptions are required")
		}
		if kind == "endpoint.update" && m.Name == nil && m.Enabled == nil && m.Destination == nil && !m.HasSubscriptions {
			return m, httpx.InvalidInput("at least one configuration field is required")
		}
	}
	if kind == "signing.rotate" {
		m.Mode, err = httpx.RequiredString(fields, "mode")
		if err != nil {
			return m, err
		}
		if m.Mode != "overlap" && m.Mode != "immediate" {
			return m, httpx.InvalidInput("mode must be overlap or immediate")
		}
	}
	return m, nil
}

func listInput(r *http.Request) (ListQuery, error) {
	values, err := httpx.QueryValues(r, "q", "enabled", "limit", "cursor")
	if err != nil {
		return ListQuery{}, err
	}
	page, err := httpx.PageValues(values)
	if err != nil {
		return ListQuery{}, err
	}
	result := ListQuery{Limit: page.Limit, Cursor: page.Cursor, Query: values.Get("q")}
	if !utf8.ValidString(result.Query) || utf8.RuneCountInString(result.Query) > 200 {
		return ListQuery{}, httpx.InvalidInput("q must contain at most 200 Unicode characters")
	}
	if _, ok := values["enabled"]; ok {
		v := values.Get("enabled")
		if v != "true" && v != "false" {
			return ListQuery{}, httpx.InvalidInput("enabled must be true or false")
		}
		b := v == "true"
		result.Enabled = &b
	}
	return result, nil
}
