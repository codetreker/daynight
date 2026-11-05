package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

func personalTeam(ctx context.Context, tx pgx.Tx, userID, lock string) (string, error) {
	var teamID string
	err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE personal_user_id=$1`+lock, userID).Scan(&teamID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("user Personal Team is missing")
	}
	if err != nil {
		return "", err
	}
	var valid bool
	err = tx.QueryRow(ctx, `SELECT count(*)=1 AND bool_and(user_id=$2 AND role='admin')
		FROM team_members WHERE team_id=$1`, teamID, userID).Scan(&valid)
	if err != nil {
		return "", err
	}
	if !valid {
		return "", fmt.Errorf("Personal Team owner membership is invalid")
	}
	return teamID, nil
}
