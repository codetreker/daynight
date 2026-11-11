package config

type Config struct {
	PreregisteredClients map[string][]byte `yaml:"preregistered_clients"`
}

func DefaultConfig() Config { return Config{} }

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	if value, ok := lookup(oauthClientsField); ok {
		clients, err := parseOAuthClients(value)
		if err != nil {
			return err
		}
		c.PreregisteredClients = clients
		mark("preregistered_clients", oauthClientsField)
	}
	return nil
}

func (c Config) Validate() error { return validateOAuthClients(c.PreregisteredClients) }
