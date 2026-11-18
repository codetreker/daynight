package repositoryidentity

import "testing"

func TestRepositoryIdentityHostBoundaries(t *testing.T) {
	for input, want := range map[string]string{
		"https://HOST.example/Repo.git":       "host.example/Repo",
		"https://%C3%89XAMPLE.test/Repo.git":  "éxample.test/Repo",
		"git@192.0.2.1:Repo.git":              "192.0.2.1/Repo",
		"https://[2001:0db8:0:0::1]/Repo.git": "[2001:db8::1]/Repo",
	} {
		got, err := RepositoryIdentity(input)
		if err != nil || got != want {
			t.Errorf("RepositoryIdentity(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	for _, input := range []string{
		"https:///Repo.git",
		"https://bad^host/Repo.git",
		`https://bad\host/Repo.git`,
		"git@bad^host:Repo.git",
		"https://[not-an-ip]/Repo.git",
		"https://[192.0.2.1]/Repo.git",
		"ssh://git@[fe80::1%25eth0]/Repo.git",
		"https://%61.example/Repo.git",
	} {
		if got, err := RepositoryIdentity(input); err == nil || got != "" {
			t.Errorf("invalid host in %q returned identity %q and error %v", input, got, err)
		}
	}
}
