package config

import (
	"encoding/json"
	"io"
	"strings"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

const oauthClientsField = "DAYNIGHT_OAUTH_PREREGISTERED_CLIENTS"

func invalidOAuthClients() error {
	return &configvalue.ConfigurationError{Field: oauthClientsField, Rule: "must be a JSON object of valid public client metadata keyed by client_id"}
}

func parseOAuthClients(value string) (map[string][]byte, error) {
	if value == "" {
		return nil, nil
	}
	if len(value) > 1<<20 {
		return nil, invalidOAuthClients()
	}
	d := json.NewDecoder(strings.NewReader(value))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return nil, invalidOAuthClients()
	}
	clients := make(map[string][]byte)
	for d.More() {
		key, err := d.Token()
		id, ok := key.(string)
		if err != nil || !ok || id == "" {
			return nil, invalidOAuthClients()
		}
		if _, exists := clients[id]; exists {
			return nil, invalidOAuthClients()
		}
		var data json.RawMessage
		if err := d.Decode(&data); err != nil {
			return nil, invalidOAuthClients()
		}
		clients[id] = data
	}
	if token, err = d.Token(); err != nil || token != json.Delim('}') {
		return nil, invalidOAuthClients()
	}
	if err = d.Decode(new(any)); err != io.EOF {
		return nil, invalidOAuthClients()
	}
	if err = validateOAuthClients(clients); err != nil {
		return nil, err
	}
	return clients, nil
}

func validateOAuthClients(clients map[string][]byte) error {
	for id, data := range clients {
		if id == "" || len(data) > core.MetadataLimit {
			return invalidOAuthClients()
		}
		if _, err := core.ParseClientMetadata(data, id); err != nil {
			return invalidOAuthClients()
		}
	}
	return nil
}
