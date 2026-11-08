//go:build !stress

package task_test

import (
	"fmt"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	// The module check provides infrastructure to other packages. We clear its
	// setup variables so accidental dependencies fail in these HTTP units.
	for _, name := range []string{"DAYNIGHT_TEST_DATABASE_URL", "DAYNIGHT_TEST_UNIAUTH_FIXTURE"} {
		if err := os.Unsetenv(name); err != nil {
			fmt.Fprintf(os.Stderr, "clear %s before HTTP unit tests: %v\n", name, err)
			os.Exit(1)
		}
	}
	os.Exit(m.Run())
}
