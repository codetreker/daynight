package sessionrelay

import "github.com/codetreker/daynight/packages/daynight-server/internal/sessionarchive"

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

func validateArchiveObjectPath(project, owner, session, digest, actual string) error {
	expected, err := archiveObjectPath(project, owner, session, digest)
	if err != nil {
		return err
	}
	if actual != expected {
		return fault("source_corrupt", "Session archive object path does not match the current layout; run offline Session archive layout migration.")
	}
	return nil
}
