"""Refresh private channel-name redactions from local metadata; never export names or credentials."""
import argparse
import json
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', choices=['art', 'cart'], required=True)
    args = parser.parse_args()
    container = {'art': 'tokensbyte-postgres', 'cart': 'tkeapi-postgres'}[args.site]
    names = subprocess.check_output(['docker', 'exec', container, 'sh', '-c',
        'printf \'%s\\n%s\\n\' "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"'],
        text=True, timeout=3).splitlines()
    sql = """BEGIN READ ONLY; SET LOCAL statement_timeout='3s';
    SELECT coalesce(json_agg(name),'[]') FROM (
      SELECT coalesce(to_jsonb(c)->>'name',to_jsonb(c)->>'channel_name') AS name
      FROM channels c ORDER BY id DESC LIMIT 200
    ) n; COMMIT;"""
    result = subprocess.run(['docker', 'exec', '-i', container, 'psql', '-X', '-q', '-At',
        '-U', names[0], '-d', names[1], '-v', 'ON_ERROR_STOP=1'], input=sql, text=True,
        capture_output=True, check=True, timeout=5)
    policy = Path('/etc/corvas-customer-error-policy.json')
    current = json.loads(policy.read_text()) if policy.exists() else {'privateTerms': []}
    terms = current.get('privateTerms', [])
    if not isinstance(terms, list) or not all(isinstance(term, str) for term in terms):
        raise ValueError('Invalid existing private terms; preserving policy')
    additions = [name for name in json.loads(result.stdout) if isinstance(name, str) and 3 <= len(name) <= 160 and any(char.isalpha() for char in name)]
    all_terms = list(dict.fromkeys(terms + additions))
    current['privateTerms'] = all_terms[:200]
    temporary = policy.with_suffix('.json.next')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(current, output, ensure_ascii=True)
    os.chmod(temporary, 0o600)
    os.replace(temporary, policy)
    print(json.dumps({'privateTermsCount': len(current['privateTerms']), 'truncated': len(all_terms) > 200}))


if __name__ == '__main__':
    main()
