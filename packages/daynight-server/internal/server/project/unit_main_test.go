//go:build !acceptance

package project

import (
	"fmt"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	// Module validation provides infrastructure for storage owners. Removing its
	// configuration here makes accidental HTTP fixture dependencies observable.
	for _, name := range []string{"DAYNIGHT_TEST_DATABASE_URL", "DAYNIGHT_TEST_UNIAUTH_FIXTURE"} {
		if err := os.Unsetenv(name); err != nil {
			fmt.Fprintf(os.Stderr, "clear %s before Project HTTP unit tests: %v\n", name, err)
			os.Exit(1)
		}
	}
	os.Exit(m.Run())
}
