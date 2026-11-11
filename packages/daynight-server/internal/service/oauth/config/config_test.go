package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestPreregisteredClients(t *testing.T) {
	valid := `{"known":{"client_id":"known","redirect_uris":["https://client.example/callback"]}}`
	c := DefaultConfig()
	mark := ""
	apply := func(value string) error {
		return c.ApplyEnvironment(func(string) (string, bool) { return value, true }, func(field, variable string) { mark = field + ":" + variable })
	}
	if err := apply(valid); err != nil || len(c.PreregisteredClients["known"]) == 0 || c.Validate() != nil || mark != "preregistered_clients:DAYNIGHT_OAUTH_PREREGISTERED_CLIENTS" {
		t.Fatalf("valid preregistration: %v", err)
	}
	for _, value := range []string{`[]`, `null`, `{"known":null}`, `{"known":{"client_id":"other","redirect_uris":["https://client.example/callback"]}}`, `{"a":{},"a":{}}`, valid + ` {}`, strings.Repeat("x", 1<<20+1)} {
		err := apply(value)
		var failure *configvalue.ConfigurationError
		if !errors.As(err, &failure) || failure.Field != "preregistered_clients" || strings.Contains(err.Error(), value) {
			t.Fatalf("invalid preregistration accepted or disclosed: %v", err)
		}
	}
	if err := apply(""); err != nil || len(c.PreregisteredClients) != 0 {
		t.Fatalf("empty table: %v", err)
	}
	c.PreregisteredClients = map[string][]byte{"bad": []byte(`null`)}
	if c.Validate() == nil {
		t.Fatal("invalid manually constructed metadata accepted")
	}
}
