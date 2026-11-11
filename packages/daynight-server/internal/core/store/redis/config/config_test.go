package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestConfiguration(t *testing.T) {
	for _, value := range []string{"", "redis://127.0.0.1:6379/0", "redis://127.0.0.1:6379?db=1", "rediss://user:secret@redis.example:6380/1"} {
		c := DefaultConfig()
		marked := false
		if err := c.ApplyEnvironment(func(key string) (string, bool) { return value, key == "DAYNIGHT_REDIS_URL" }, func(field, variable string) { marked = field == "redis_url" && variable == "DAYNIGHT_REDIS_URL" }); err != nil || !marked || c.RedisURL != value || c.Validate() != nil {
			t.Fatalf("valid URL not preserved: %q, %v", value, err)
		}
		if err := c.ApplyEnvironment(func(string) (string, bool) { return "ignored", false }, nil); err != nil || c.RedisURL != value {
			t.Fatalf("absent environment changed configuration: %+v %v", c, err)
		}
	}
	for _, value := range []string{" ", "https://example.com", "unix:///tmp/redis.sock", "redis://host:word", "redis://host:", "redis://host:0", "redis://host:99999", "redis://host/-1", "redis://host?db=-1", "redis://host?db=", "redis://host?pool_size=2147483648", "redis://host?min_idle_conns=999999999", "redis://host?db=0&db=1", "redis://host/invalid", "redis://user:secret@bad%host"} {
		err := (Config{RedisURL: value}).Validate()
		var failure *configvalue.ConfigurationError
		if !errors.As(err, &failure) || failure.Field != "DAYNIGHT_REDIS_URL" || failure.Cause == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("invalid Redis URL accepted or disclosed: %v", err)
		}
	}
}
