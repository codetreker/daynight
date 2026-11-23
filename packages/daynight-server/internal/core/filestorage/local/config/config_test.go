package config

import "testing"

func TestConfiguration(t *testing.T) {
	c := DefaultConfig()
	for _, value := range []string{"", " \t"} {
		c.Root = value
		if err := c.Validate(); err == nil || err.Error() != "root must be nonempty and contain no control characters" {
			t.Fatalf("invalid root %q: %v", value, err)
		}
	}
	called := false
	if err := c.ApplyEnvironment(func(key string) (string, bool) { return "a/root/that/does/not/exist", key == "DAYNIGHT_STORAGE_ROOT" }, func(field, variable string) { called = field == "root" && variable == "DAYNIGHT_STORAGE_ROOT" }); err != nil {
		t.Fatal(err)
	}
	if !called || c.Root != "a/root/that/does/not/exist" || c.Validate() != nil {
		t.Fatalf("configuration validation should not initialize filesystem: %+v", c)
	}
	if err := c.ApplyEnvironment(func(string) (string, bool) { return "ignored", false }, nil); err != nil || c.Root != "a/root/that/does/not/exist" {
		t.Fatalf("absent environment changed configuration: %+v %v", c, err)
	}
}

func TestResolvePathsPreservesTraversal(t *testing.T) {
	c := DefaultConfig()
	if c.Root != "storage" {
		t.Fatalf("default: %q", c.Root)
	}
	c.Root = "link/../storage"
	if err := c.ResolvePaths("/srv/daynight"); err != nil || c.Root != "/srv/daynight/link/../storage" {
		t.Fatalf("resolution: %q %v", c.Root, err)
	}
	for _, value := range []string{"", " ", "x\n"} {
		c.Root = value
		if c.ResolvePaths("/srv/daynight") == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	c.Root = "/other/storage"
	if err := c.ResolvePaths("/srv/daynight"); err != nil || c.Root != "/other/storage" {
		t.Fatalf("absolute: %q %v", c.Root, err)
	}
}

func TestArchiveStagingConfiguration(t *testing.T) {
	c := DefaultConfig()
	values := map[string]string{"DAYNIGHT_STORAGE_ARCHIVE_UPLOAD_V2_ENABLED": "true"}
	lookup := func(key string) (string, bool) { value, ok := values[key]; return value, ok }
	if err := c.ApplyEnvironment(lookup, nil); err != nil || c.Validate() == nil {
		t.Fatalf("unverified topology accepted: %+v %v", c, err)
	}
	values["DAYNIGHT_STORAGE_ARCHIVE_STAGING_TOPOLOGY_VERIFIED"] = "true"
	if err := c.ApplyEnvironment(lookup, nil); err != nil || c.Validate() != nil {
		t.Fatalf("verified topology rejected: %+v %v", c, err)
	}
	values["DAYNIGHT_STORAGE_ARCHIVE_UPLOAD_V2_ENABLED"] = "invalid"
	if c.ApplyEnvironment(lookup, nil) == nil {
		t.Fatal("invalid boolean accepted")
	}
}

func TestArchiveStagingPatchPreservesExplicitFalse(t *testing.T) {
	c := DefaultConfig()
	root, enabled := "/data", true
	if err := (Patch{Root: &root, ArchiveStagingTopologyVerified: &enabled, ArchiveUploadV2Enabled: &enabled}).ApplyTo(&c); err != nil {
		t.Fatal(err)
	}
	disabled := false
	if err := (Patch{ArchiveUploadV2Enabled: &disabled}).ApplyTo(&c); err != nil {
		t.Fatal(err)
	}
	if c.Root != root || !c.ArchiveStagingTopologyVerified || c.ArchiveUploadV2Enabled || c.Validate() != nil {
		t.Fatalf("patch did not preserve topology while disabling registration: %+v", c)
	}
}

func TestBackendConfiguration(t *testing.T) {
	c := DefaultConfig()
	if c.BackendName() != "local" || c.Validate() != nil {
		t.Fatalf("local default: %+v", c)
	}
	for _, value := range []string{"", "invalid", "LOCAL", " azure-blob"} {
		c = DefaultConfig()
		if err := (Patch{Backend: &value}).ApplyTo(&c); err != nil {
			t.Fatal(err)
		}
		if c.Validate() == nil {
			t.Fatalf("accepted backend %q", value)
		}
	}
	c = DefaultConfig()
	c.Backend = "azure-blob"
	c.Azure.Container = "container"
	if c.Validate() == nil {
		t.Fatal("Azure accepted without credentials")
	}
	c.Azure.Endpoint = "https://account.blob.core.windows.net"
	c.ArchiveUploadV2Enabled = true
	if err := c.Validate(); err != nil {
		t.Fatalf("Azure managed identity: %v", err)
	}
	c.Azure.ConnectionString = "secret"
	if c.Validate() == nil {
		t.Fatal("mixed credentials accepted")
	}
	c.Azure.Endpoint = ""
	c.Azure.ManagedIdentityClientID = "client"
	if c.Validate() == nil {
		t.Fatal("connection string and identity accepted")
	}
	c.Azure.ManagedIdentityClientID = ""
	if err := c.Validate(); err != nil {
		t.Fatalf("connection string: %v", err)
	}
	c.Azure.ConnectionString = ""
	for _, endpoint := range []string{"http://account", "https://user:secret@account", "https://account?secret=x"} {
		c.Azure.Endpoint = endpoint
		if c.Validate() == nil {
			t.Fatalf("accepted endpoint %q", endpoint)
		}
	}
}

func TestBackendEnvironmentOverridesPatch(t *testing.T) {
	c := DefaultConfig()
	empty := ""
	if err := (Patch{Backend: &empty}).ApplyTo(&c); err != nil {
		t.Fatal(err)
	}
	if c.Validate() == nil {
		t.Fatal("explicitly empty backend accepted")
	}
	values := map[string]string{
		"DAYNIGHT_STORAGE_BACKEND":                 "azure-blob",
		"DAYNIGHT_STORAGE_AZURE_CONTAINER":         "test",
		"DAYNIGHT_STORAGE_AZURE_CONNECTION_STRING": "secret",
	}
	fields := map[string]string{}
	if err := c.ApplyEnvironment(func(key string) (string, bool) { value, ok := values[key]; return value, ok }, func(field, variable string) { fields[field] = variable }); err != nil {
		t.Fatal(err)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if fields["azure.container"] != "DAYNIGHT_STORAGE_AZURE_CONTAINER" || c.Azure.ConnectionString != "secret" {
		t.Fatalf("override: %+v, %v", c, fields)
	}
}
