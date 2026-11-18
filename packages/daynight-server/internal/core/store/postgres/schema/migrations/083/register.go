package migration083

import _ "embed"

//go:embed migrations/083_project_repository_identity.sql
var repositoryIdentitySQL string

// SQL returns migration 083's frozen schema change.
func SQL() string { return repositoryIdentitySQL }
