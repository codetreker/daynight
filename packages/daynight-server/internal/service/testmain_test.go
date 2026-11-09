package service

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	for _, key := range []string{"DAYNIGHT_TEST_DATABASE_URL", "DAYNIGHT_TEST_UNIAUTH_FIXTURE"} {
		if err := os.Unsetenv(key); err != nil {
			panic(err)
		}
	}
	os.Exit(m.Run())
}
