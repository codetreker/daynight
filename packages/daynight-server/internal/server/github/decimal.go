package github

import (
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"strconv"
)

func decimalField(fields map[string]json.RawMessage, key string) (int64, error) {
	value, err := httpx.RequiredString(fields, key)
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 1 || strconv.FormatInt(n, 10) != value {
		return 0, httpx.InvalidInput(key + " must be a positive decimal string")
	}
	return n, nil
}
