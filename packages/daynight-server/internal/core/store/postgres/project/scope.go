package project

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

type reader struct{ tx pgx.Tx }
type writer struct {
	tx        pgx.Tx
	projectID string
}
type creator struct {
	tx     pgx.Tx
	userID string
}
type thread struct{ tx pgx.Tx }

func NewReader(tx pgx.Tx) store.ProjectReader { return &reader{tx: tx} }
func NewWriter(tx pgx.Tx, projectID string) store.ProjectWriteDAO {
	return &writer{tx: tx, projectID: projectID}
}
func NewCreation(tx pgx.Tx, userID string) store.ProjectCreationDAO {
	return &creator{tx: tx, userID: userID}
}
func NewThreadDAO(tx pgx.Tx) store.ThreadProjectDAO { return &thread{tx: tx} }

var _ store.ProjectReader = (*reader)(nil)
var _ store.ProjectWriteDAO = (*writer)(nil)
var _ store.ProjectCreationDAO = (*creator)(nil)
var _ store.ThreadProjectDAO = (*thread)(nil)
