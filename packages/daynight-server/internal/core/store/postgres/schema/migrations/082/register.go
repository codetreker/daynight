package migration082

import _ "embed"

//go:embed migrations/082_project_repository_identity.sql
var repositoryIdentitySQL string

// SQL returns migration 082's frozen schema change.
func SQL() string { return repositoryIdentitySQL }
