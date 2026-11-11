package config

import "testing"

func TestConfiguration(t *testing.T) {
	c := DefaultConfig()
	for _, value := range []string{"", " \t"} {
		c.URL = value
		if err := c.Validate(); err == nil || err.Error() != "DAYNIGHT_DATABASE_URL is required" {
			t.Fatalf("invalid URL %q: %v", value, err)
		}
	}
	called := false
	if err := c.ApplyEnvironment(func(key string) (string, bool) { return "postgres://example/db", key == "DAYNIGHT_DATABASE_URL" }, func(field, variable string) { called = field == "url" && variable == "DAYNIGHT_DATABASE_URL" }); err != nil {
		t.Fatal(err)
	}
	if !called || c.URL != "postgres://example/db" || c.Validate() != nil {
		t.Fatalf("configuration not applied: %+v", c)
	}
	if err := c.ApplyEnvironment(func(string) (string, bool) { return "ignored", false }, nil); err != nil || c.URL != "postgres://example/db" {
		t.Fatalf("absent environment changed configuration: %+v %v", c, err)
	}
}
