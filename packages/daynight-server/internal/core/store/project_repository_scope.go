package store

import "context"

// ProjectRepositoryScope binds the Project, GitHub and Worker operations to one transaction.
type ProjectRepositoryReadScope interface {
	ProjectRepositoryDAO() ProjectRepositoryReadDAO
	GitHubAppDAO() GitHubProjectAppReadDAO
}
type ProjectRepositoryWriteScope interface {
	ProjectRepositoryDAO() ProjectRepositoryWriteDAO
	GitHubAppDAO() GitHubProjectAppReadDAO
	GitHubSwitchDAO() GitHubRepositorySwitchDAO
	WorkerSelectionsDAO() WorkerProjectSelectionDAO
}
type ProjectRepositoryStore interface {
	ReadProjectRepository(context.Context, string, func(ProjectRepositoryReadScope) error) error
	WriteProjectRepository(context.Context, string, string, func(ProjectRepositoryWriteScope) error) (Completion, error)
}
