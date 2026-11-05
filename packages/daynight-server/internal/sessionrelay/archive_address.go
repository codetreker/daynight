package sessionrelay

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"

func archiveNamespace(project, owner, session string) (sessionarchive.Namespace, error) {
	if project == "" {
		return sessionarchive.NewNamespace(sessionarchive.Users, owner, session)
	}
	return sessionarchive.NewNamespace(sessionarchive.Projects, project, session)
}

func archiveObjectPath(project, owner, session, digest string) (string, error) {
	namespace, err := archiveNamespace(project, owner, session)
	if err != nil {
		return "", err
	}
	return namespace.ObjectPath(digest)
}
