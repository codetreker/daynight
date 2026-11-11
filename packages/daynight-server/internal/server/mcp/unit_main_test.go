//go:build !stress

package mcp

import (
	"fmt"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	// Other packages receive infrastructure from the module check. Clearing its
	// setup variables keeps accidental business fixtures visible in MCP units.
	for _, name := range []string{"DAYNIGHT_TEST_DATABASE_URL", "DAYNIGHT_TEST_UNIAUTH_FIXTURE"} {
		if err := os.Unsetenv(name); err != nil {
			fmt.Fprintf(os.Stderr, "clear %s before MCP unit tests: %v\n", name, err)
			os.Exit(1)
		}
	}
	os.Exit(m.Run())
}
