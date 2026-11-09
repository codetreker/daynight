package mcp

import "fmt"

// SessionToolModule registers a complete Session capability. Read and send
// modules supply their own definitions and shared-service dependencies.
// No unimplemented Session commands are advertised by this composition seam.
type SessionToolModule func(*Entry) error

func RegisterSessionTools(entry *Entry, modules ...SessionToolModule) error {
	if entry == nil {
		return fmt.Errorf("MCP session tools require an entry")
	}
	for _, register := range modules {
		if register == nil {
			return fmt.Errorf("MCP session tool module is required")
		}
		if err := register(entry); err != nil {
			return err
		}
	}
	return nil
}
