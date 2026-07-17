package auth

// RoleSatisfies reports whether have grants at least the privileges of need.
func RoleSatisfies(have, need string) bool {
	rank := map[string]int{"member": 1, "admin": 2, "owner": 3}
	haveRank, haveOK := rank[have]
	needRank, needOK := rank[need]
	return haveOK && needOK && haveRank >= needRank
}
