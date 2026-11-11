package config

import (
	"encoding/json"
	"testing"

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
	if err := json.Unmarshal(c.PreregisteredClients["known"], &metadata); err != nil || metadata["extra"] != nil {
		t.Fatalf("metadata extension: %s %v", c.PreregisteredClients["known"], err)
	}
	if err := yaml.Load([]byte("preregistered_clients: {}\n"), &p); err != nil {
		t.Fatal(err)
	}
	if err := p.ApplyTo(&c); err != nil || len(c.PreregisteredClients) != 0 {
		t.Fatalf("empty table did not clear: %+v %v", c, err)
	}
}
