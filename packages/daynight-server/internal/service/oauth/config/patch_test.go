package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
	"go.yaml.in/yaml/v4"
)

func TestYAMLPatchReplacesClientsAndRetainsMetadata(t *testing.T) {
	c := Config{PreregisteredClients: map[string][]byte{"old": []byte(`{}`)}}
	var p Patch
	data := []byte("preregistered_clients:\n  known:\n    client_id: known\n    redirect_uris: [https://client.example/callback]\n    extra: null\n")
	if err := yaml.Load(data, &p); err != nil {
		t.Fatal(err)
	}
	if err := p.ApplyTo(&c); err != nil {
		t.Fatal(err)
	}
	if len(c.PreregisteredClients) != 1 || c.Validate() != nil {
		t.Fatalf("replacement or validation: %+v", c)
	}
	var metadata map[string]any
	err := json.Unmarshal(c.PreregisteredClients["known"], &metadata)
	extra, present := metadata["extra"]
	if err != nil || !present || extra != nil {
		t.Fatalf("metadata extension: %s %v", c.PreregisteredClients["known"], err)
	}
	if err := yaml.Load([]byte("preregistered_clients: {}\n"), &p); err != nil {
		t.Fatal(err)
	}
	if err := p.ApplyTo(&c); err != nil || len(c.PreregisteredClients) != 0 {
		t.Fatalf("empty table did not clear: %+v %v", c, err)
	}
}

func TestYAMLPatchRejectsNonJSONAndPreservesPreviousClients(t *testing.T) {
	c := Config{PreregisteredClients: map[string][]byte{"old": []byte(`{"client_id":"old"}`)}}
	if err := (Patch{}).ApplyTo(&c); err != nil || len(c.PreregisteredClients) != 1 {
		t.Fatalf("omitted table changed clients: %+v %v", c, err)
	}
	for _, input := range []string{
		"preregistered_clients: secret-value\n",
		"preregistered_clients:\n  known:\n    extension: !private secret-value\n",
	} {
		var patch Patch
		if err := yaml.Load([]byte(input), &patch); err != nil {
			t.Fatal(err)
		}
		err := patch.ApplyTo(&c)
		var failure *configvalue.ConfigurationError
		if !errors.As(err, &failure) || failure.Field != "preregistered_clients" || strings.Contains(err.Error(), "secret-value") {
			t.Fatalf("expected safe configuration error, got %v", err)
		}
		if len(c.PreregisteredClients) != 1 || string(c.PreregisteredClients["old"]) != `{"client_id":"old"}` {
			t.Fatalf("failed patch changed clients: %+v", c)
		}
	}
}

func TestClientsValidateAggregateJSONLimit(t *testing.T) {
	clients := make(map[string][]byte)
	for i := 0; i < 18; i++ {
		id := fmt.Sprintf("client-%d", i)
		metadata, err := json.Marshal(map[string]any{
			"client_id": id, "redirect_uris": []string{"https://client.example/callback"},
			"extension": strings.Repeat("x", 60_000),
		})
		if err != nil {
			t.Fatal(err)
		}
		clients[id] = metadata
	}
	if err := validateOAuthClients(clients); err != nil {
		t.Fatalf("individual clients should be valid: %v", err)
	}
	if err := (Config{PreregisteredClients: clients}).Validate(); err == nil {
		t.Fatal("oversized aggregate table accepted")
	}
}
