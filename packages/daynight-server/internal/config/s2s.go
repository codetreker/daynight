package config

import (
	corsconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/cors/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type S2SConfig struct {
	corsconfig.Config `yaml:",inline"`
	SharedKey         string `yaml:"shared_key"`
}

type s2sPatch struct {
	corsconfig.Patch `yaml:",inline"`
	SharedKey        *string `yaml:"shared_key"`
}

func (p s2sPatch) ApplyTo(c *S2SConfig) error {
	if err := p.Patch.ApplyTo(&c.Config); err != nil {
		return err
	}
	if p.SharedKey != nil {
		c.SharedKey = *p.SharedKey
	}
	return nil
}

func (c *S2SConfig) ApplyEnvironment(lookup func(string) (string, bool), mark func(string, string)) error {
	if err := c.Config.ApplyEnvironment(lookup, mark); err != nil {
		return err
	}
	const variable = "DAYNIGHT_S2S_SHARED_KEY"
	if value, ok := lookup(variable); ok {
		c.SharedKey = value
		mark("shared_key", variable)
	}
	return nil
}

func (c S2SConfig) Validate(allowHTTPTestOrigin bool) error {
	if c.SharedKey != "" {
		valid := len(c.SharedKey) >= 32 && len(c.SharedKey) <= 256
		for i := 0; i < len(c.SharedKey); i++ {
			valid = valid && c.SharedKey[i] >= 0x21 && c.SharedKey[i] <= 0x7e
		}
		if !valid {
			return &configvalue.ConfigurationError{Field: "shared_key", Rule: "must be empty or contain 32 through 256 visible ASCII bytes"}
		}
	}
	return c.Config.Validate(allowHTTPTestOrigin)
}
