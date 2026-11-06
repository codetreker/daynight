package worker

import (
	"bytes"
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

func workerAssistantHostInput(raw json.RawMessage) (*model.WorkerAssistantHost, error) {
	fields, err := jsonobject.Decode(raw, "assistantHost", "protocolVersion", "observedAt", "defaultCwd", "defaultProvider", "providers", "creationConfigurationVersion")
	if err != nil {
		return nil, httpx.InvalidInput(err.Error())
	}
	for _, key := range []string{"protocolVersion", "observedAt", "defaultCwd", "defaultProvider", "providers"} {
		if _, exists := fields[key]; !exists {
			return nil, httpx.InvalidInput("assistantHost." + key + " is required")
		}
	}
	host := &model.WorkerAssistantHost{}
	if raw, exists := fields["creationConfigurationVersion"]; exists {
		value, err := workerIntegerInput(raw)
		if err != nil || value != 1 {
			return nil, httpx.InvalidInput("assistantHost.creationConfigurationVersion must be 1")
		}
		host.CreationConfigurationVersion = 1
	}
	host.ProtocolVersion, err = workerIntegerInput(fields["protocolVersion"])
	if err != nil {
		return nil, err
	}
	host.ObservedAt, err = workerTimeInput(fields, "observedAt")
	if err != nil {
		return nil, err
	}
	host.DefaultCwd, err = httpx.RequiredString(fields, "defaultCwd")
	if err != nil {
		return nil, err
	}
	provider, err := httpx.RequiredString(fields, "defaultProvider")
	if err != nil {
		return nil, err
	}
	host.DefaultProvider = model.WorkerAgent(provider)
	var providers []json.RawMessage
	if json.Unmarshal(fields["providers"], &providers) != nil || providers == nil {
		return nil, httpx.InvalidInput("assistantHost.providers must be an array")
	}
	host.Providers = make([]model.WorkerAssistantProvider, 0, len(providers))
	for _, raw := range providers {
		provider, err := workerAssistantProviderInput(raw)
		if err != nil {
			return nil, err
		}
		host.Providers = append(host.Providers, provider)
	}
	return host, nil
}

func workerAssistantProviderInput(raw json.RawMessage) (model.WorkerAssistantProvider, error) {
	var provider model.WorkerAssistantProvider
	fields, err := workerObject(raw, "assistantHost.providers", "provider", "available", "reason", "model", "args")
	if err != nil {
		return provider, err
	}
	name, err := httpx.RequiredString(fields, "provider")
	if err != nil {
		return provider, err
	}
	provider.Provider = model.WorkerAgent(name)
	if bytes.Equal(bytes.TrimSpace(fields["available"]), []byte("null")) || json.Unmarshal(fields["available"], &provider.Available) != nil {
		return provider, httpx.InvalidInput("assistantHost provider available must be a boolean")
	}
	for name, destination := range map[string]**string{"reason": &provider.Reason, "model": &provider.Model} {
		if bytes.Equal(bytes.TrimSpace(fields[name]), []byte("null")) {
			continue
		}
		value, err := httpx.RequiredString(fields, name)
		if err != nil {
			return provider, err
		}
		*destination = &value
	}
	var args []json.RawMessage
	if json.Unmarshal(fields["args"], &args) != nil || args == nil {
		return provider, httpx.InvalidInput("assistantHost provider args must be an array")
	}
	provider.Args = make([]string, 0, len(args))
	for _, raw := range args {
		value, err := httpx.RequiredString(map[string]json.RawMessage{"argument": raw}, "argument")
		if err != nil {
			return provider, err
		}
		provider.Args = append(provider.Args, value)
	}
	return provider, nil
}
