package config

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
	"go.yaml.in/yaml/v4"
)

type Config struct {
	PreregisteredClients map[string][]byte `yaml:"preregistered_clients"`
}

type Patch struct {
	PreregisteredClients *ClientPatch `yaml:"preregistered_clients"`
}

// ClientPatch keeps the original YAML nodes until their JSON conversion.
type ClientPatch struct{ node *yaml.Node }

func (p *ClientPatch) UnmarshalYAML(node *yaml.Node) error {
	p.node = node
	return nil
}

func (p Patch) ApplyTo(c *Config) error {
	if p.PreregisteredClients == nil {
		return nil
	}
	value, err := configvalue.JSONValue(p.PreregisteredClients.node)
	if err != nil {
		return &configvalue.ConfigurationError{Field: "preregistered_clients", Rule: "must be a JSON-compatible mapping", Cause: err}
	}
	if _, ok := value.(map[string]any); !ok {
		return &configvalue.ConfigurationError{Field: "preregistered_clients", Rule: "must be a JSON-compatible mapping"}
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return &configvalue.ConfigurationError{Field: "preregistered_clients", Rule: "must be a JSON-compatible mapping", Cause: err}
	}
	var clients map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &clients); err != nil {
		return &configvalue.ConfigurationError{Field: "preregistered_clients", Rule: "must be a JSON-compatible mapping", Cause: err}
	}
	c.PreregisteredClients = make(map[string][]byte, len(clients))
	for id, data := range clients {
		c.PreregisteredClients[id] = data
	}
	return nil
}

func DefaultConfig() Config { return Config{} }

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	if value, ok := lookup(oauthClientsField); ok {
		mark("preregistered_clients", oauthClientsField)
		clients, err := parseOAuthClients(value)
		if err != nil {
			return err
		}
		c.PreregisteredClients = clients
	}
	return nil
}

func (c Config) Validate() error {
	clients := make(map[string]json.RawMessage, len(c.PreregisteredClients))
	for id, data := range c.PreregisteredClients {
		clients[id] = data
	}
	encoded, err := json.Marshal(clients)
	if err != nil || len(encoded) > 1<<20 {
		return invalidOAuthClients()
	}
	return validateOAuthClients(c.PreregisteredClients)
}
