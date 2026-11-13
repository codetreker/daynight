package assistanttask

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func strictID(value string) (string, error) {
	id, err := model.CanonicalID(value)
	if err != nil || id != value || id == "00000000-0000-0000-0000-000000000000" {
		return "", httpx.InvalidInput("ID must be a nonzero canonical lowercase UUID")
	}
	return id, nil
}

func botIdentity(request *http.Request) (*string, error) {
	values, exists := request.Header[http.CanonicalHeaderKey("X-Daynight-Bot-Id")]
	if !exists {
		return nil, nil
	}
	if len(values) != 1 {
		return nil, httpx.InvalidInput("X-Daynight-Bot-Id must occur exactly once")
	}
	value, err := strictID(values[0])
	if err != nil {
		return nil, err
	}
	return &value, nil
}

type inputFields struct {
	fields map[string]json.RawMessage
	err    error
}

func (p *inputFields) text(key string, required bool) string {
	if p.err != nil {
		return ""
	}
	var value *string
	value, p.err = httpx.OptionalString(p.fields, key)
	if p.err != nil {
		return ""
	}
	if value == nil {
		if required {
			p.err = httpx.InvalidInput(key + " is required and must be a string")
		}
		return ""
	}
	return *value
}

func (p *inputFields) id(key string, required bool) string {
	value := p.text(key, required)
	if p.err == nil && (required || p.fields[key] != nil) {
		value, p.err = strictID(value)
	}
	return value
}

func (p *inputFields) integer(key string, required, zero bool) int64 {
	value := p.text(key, required)
	if p.err != nil || !required && p.fields[key] == nil {
		return 0
	}
	number, err := strconv.ParseInt(value, 10, 64)
	if err != nil || number < 0 || !zero && number == 0 || strconv.FormatInt(number, 10) != value {
		p.err = httpx.InvalidInput(key + " must be an exact decimal int64 string")
		return 0
	}
	return number
}

func (p *inputFields) strings(key string) []string {
	if p.err != nil {
		return nil
	}
	value, err := httpx.OptionalStrings(p.fields, key)
	p.err = err
	if value == nil {
		return nil
	}
	return *value
}

func (p *inputFields) raw(key string) json.RawMessage {
	value := p.fields[key]
	if value != nil && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		p.err = httpx.InvalidInput(key + " must not be null")
	}
	return value
}

func pageRequest(request *http.Request, allowed ...string) (model.PageRequest, error) {
	values, err := httpx.QueryValues(request, append([]string{"limit", "cursor"}, allowed...)...)
	if err != nil {
		return model.PageRequest{}, err
	}
	page := model.PageRequest{Limit: 50}
	if value, exists := values["limit"]; exists {
		limit, err := strconv.Atoi(value[0])
		if err != nil || limit < 1 || limit > 200 || strconv.Itoa(limit) != value[0] {
			return model.PageRequest{}, httpx.InvalidInput("limit must be an integer from 1 to 200")
		}
		page.Limit = limit
	}
	if value, exists := values["cursor"]; exists {
		page.Cursor = &value[0]
	}
	return page, nil
}

func noQuery(request *http.Request) error {
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		return httpx.InvalidInput("this operation does not accept query parameters")
	}
	return nil
}
