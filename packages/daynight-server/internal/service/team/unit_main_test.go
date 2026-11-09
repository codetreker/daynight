package team

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	if err := os.Unsetenv("DAYNIGHT_TEST_DATABASE_URL"); err != nil {
		panic(err)
	}
	if err := os.Unsetenv("DAYNIGHT_TEST_UNIAUTH_FIXTURE"); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}
