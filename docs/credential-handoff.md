# The protocol for sharing a credential

A credential is a value that lets something act in your name. Sharing one is a normal
part of the work and it is the most dangerous thing in the work, because the harm of a
leaked credential is not visible in the diff that caused it.

This protocol says how a credential moves from the machine that holds it to the machine
that needs it, and how it is proved, audited and destroyed afterwards. It has one
rule at its centre:

> **A credential travels as a file, never as a value.**

A file can have permissions, a digest and a place in the world. A value in a message
has none of those: it is copied, pasted, quoted, indexed, and logged.

## What may be shared, and what may not

| Kind | May be shared | How |
| --- | --- | --- |
| A token, a key, a password, a connection string with a password in it | Only as a file, by this protocol | The file, never the value |
| The account certificate of a whole account | Only as a file, and only to a named machine | The file, and the hand over says which account it reaches |
| A credential of a **whole** account, of a whole project | Only to the machine that needs it, by this protocol | The file |
| The **name** of a credential, the kind, a prefix, a digest, the place it lives | Freely | In a message, in a board, in a document |
| The **shape** of a value, such as its length or whether it is set | Freely | In a message, in a board, in a document |
| Whether a credential is configured at all | Freely | In a message, in a board, in a document |

The distinction is between the **value** and everything **about** the value. The value
is a secret. Everything about it is not, and sharing it is what makes the work
possible: an agent can be told *which* credential to use, where it is, and how to
prove it is the right one without ever seeing it.

## The four rules

1. **A credential is never written into a message, a log, a commit, a pull request, an
   issue, a board entry or a document.** Not even a prefix of it that is long enough
   to be searched for, and not as an argument on a command line, where it is kept in
   the shell history and in the process list.
2. **A credential is never written into a file that a repository tracks.** The
   environment file of a deployment is not tracked. The file that holds a credential
   is not tracked, and it says so in the ignore rules of the repository.
3. **A credential file is readable by its owner alone.** The permissions are set when
   the file is written, and they are checked when it is read.
4. **A credential is proved by a digest, not by showing it.** A SHA-256 digest of the
   value, and a prefix, are enough to say "this is the right one" to anybody who
   already holds it. A digest cannot be turned back into the value.

## How a credential is handed over

### 1. The holder writes the file

The credential is written to a file in a directory that holds only credentials, with
the permissions that let one account read it. On a system with POSIX permissions that
is `0600` for the file and `0700` for the directory. On Windows it is an access
control list with one allowed identity.

The directory is outside every repository, and it is not a temporary directory that
something else may read.

### 2. The holder writes the manifest

Beside the credential sits a **manifest**: a small text file that says, for each
credential in the bundle:

- the **name** of the credential, which is a name and not a value;
- the **kind** of the credential;
- the **file** it is in, relative to the bundle;
- the **SHA-256 digest** of the value;
- the **prefix**: the first few characters, enough to recognise it and not enough to
  use it;
- the **machine** it is meant for;
- the **reason** it is being shared, and **when** it may be destroyed.

The manifest holds no secret. It is the part that travels in a message, and it is what
the receiver checks against.

### 3. The bundle moves by a path, not by a message

The manifest travels in a message. The bundle itself moves by a path: the holder
writes it to the place the receiver reads from, or hands it over by a channel that
does not keep a history, or copies it with a tool that writes the file with the right
permissions on the far side. **The file never passes through a chat, a ticket or a
mailbox**, because everything that passes through one is copied into a place you
cannot delete from.

### 4. The receiver verifies before it uses

Before the value is used, the receiver checks the digest of the file against the
manifest. A mismatch means the file is not the one that was sent, and the receiver
stops. The receiver then checks the permissions of the file: if it can be read by
another identity, the receiver stops as well, because a credential that another
account can read is a credential that has already leaked.

### 5. The receiver uses it without ever holding it in the message

The value is read at the moment it is needed and passed straight to the thing that
needs it, through the environment or through a file descriptor. It is never echoed,
never printed, never included in an error message, and never written to a log. A tool
that must show something about the value shows the kind, the prefix and the digest.

### 6. The hand over is recorded, and the value is destroyed

When the work is done, the receiver destroys its copy, and says so. The record that
survives is the manifest: the name, the kind, the digest, the machine, the reason and
the date. That record is what an audit needs, and it holds no secret.

If the credential is a short-lived token, the destroy step is simply its expiry.

## What a manifest looks like

The format is plain text, one credential per block, so that it can be read by a
person and by a tool.

```text
protocol: credential-handoff/1
bundle: <the name of the bundle>
written: <the moment it was written>
written_by: <the machine that wrote it>
destroy_after: <the moment it may be destroyed>

credential: <the name of the credential>
  file: <the file it is in>
  kind: <the kind of the credential>
  digest: sha256:<the digest of the value>
  prefix: <the first four characters>
  for: <the machine that may read it>
  reason: <why it is being shared>
  destroy: when the task is done, or on the date above
```

Nothing in that format is a secret, and every field of it is written by hand or by a
tool that never reads the value into a message.

## The rules about the digest and the prefix

- The **digest** is a SHA-256 of the value. It is a one-way function: it cannot be
  turned back into the value, and it cannot be searched for. It is safe to publish.
- The **prefix** is the first few characters. Four is usually enough to recognise a
  value and to compare two machines; more than that starts to be a secret in its own
  right, so the rule is **four and no more**.
- The **pair** of a digest and a prefix is what an agent is given when it is told
  which credential to use. The agent then finds the file, checks the digest, and
  uses the value.

## What to do when a credential has leaked

A credential that has been printed, committed, quoted into a message or written into
a tracked file has leaked, whatever the intent was. The response has an order, and the
order matters:

1. **Rotate it.** The credential is revoked and a new one is issued. This is the only
   step that actually removes the harm.
2. **Remove it from the place it leaked**, with a follow-up commit, and say plainly
   in the commit message that a credential was removed. The history keeps it, and
   everybody can see it was there.
3. **Never rewrite the published history to hide it.** A rewrite that removes the
   value from the history also removes the evidence that it leaked, and the rewrite
   itself destroys the trust of everyone who pulled the branch.
4. **Tell the people who need to know**: the owner of the credential, and the person
   who runs the service it belongs to.

The order is deliberate. Rotating first means the window of exposure is closed even if
the removal takes a while. A leaked credential that has been removed from the working
tree but not rotated is still a leaked credential.

## Why a file and not a value

| | A value in a message | A credential in a file |
| --- | --- | --- |
| Where it ends up | The transcript, the scrollback, the index, the log of the tool that read it, the model that was sent it | One file, in one place |
| Who can read it | Everyone who can read the transcript | The owner, and only the owner |
| Can it be removed afterwards | No. The copies are not yours | Yes. The file is deleted and the digest is what remains |
| Can it be checked | No. There is nothing to compare | Yes. The digest is checked before the value is used |
| Does it survive a handoff | Yes, in every copy of the message | Only if it is copied deliberately |
| What an audit sees | Nothing, or a leak | The name, the kind, the digest, the machine, the reason, the date |

## The short form

For the common case, the whole protocol is four steps:

1. The holder writes the value to a file that only they can read, and writes a
   manifest beside it with the name, the kind, the digest, a four-character prefix,
   the machine it is for, and the reason.
2. The holder puts **the manifest** in the message, and the path of the bundle.
3. The receiver checks the digest and the permissions, uses the value at the moment it
   is needed, and never prints it.
4. The receiver destroys its copy and says so; the manifest is the record.

## The tool that enforces it

The protocol is not a document nobody runs. `scripts/handoff.mjs` is the tool that
carries it out, and it has four subcommands:

| Command | What it does |
| --- | --- |
| `handoff write` | Writes the credential files and the manifest of a bundle, with the permissions that let only the owner read them. |
| `handoff verify` | Checks a bundle against its own manifest: the digest of every file, the permissions, the machine it is meant for, and the files it does not describe. |
| `handoff digest` | Prints the kind, the SHA-256 digest and a prefix of four characters of a file, and nothing else. |
| `handoff destroy` | Removes the credential files and leaves the record behind: the name, the kind, the digest, the machine, the reason and the date, and no value. |

```bash
node scripts/handoff.mjs write   --bundle <dir> --machine <name> --credential "<spec>"
node scripts/handoff.mjs verify  --bundle <dir> --for <machine>
node scripts/handoff.mjs digest  --kind <kind> <file>
node scripts/handoff.mjs destroy --bundle <dir> --record <file>
```

The tool has no code path that prints a value: the digest and the four-character
prefix are the only things it derives from the content of a file, and the check that a
manifest holds no value compares the content in memory without printing it. A prefix
longer than four characters is refused, a bundle inside a repository is refused unless
the caller says they know what they are doing, and nothing is read or removed outside
the bundle directory.

Its self-test builds a throwaway bundle for each of twenty cases and shows that the
tool finds the fault in every one of them.

## The check that enforces the rest

The scanner in this repository finds the shapes that must not be published: private
keys, cloud and API credentials, values that look like secrets, addresses, hostnames
outside a neutral list, and absolute paths. It is the automated half of this protocol,
and it runs in continuous integration and as a pre-commit hook.

It cannot tell a real credential from a convincing example, which is why the samples
that prove its rules work are **assembled from parts** at run time: the text in the
repository is never a complete value of the shape, while the rule still matches one.
The same is true of this document: every value in it is a placeholder, and the
placeholders are obvious on purpose.

## The questions to ask before sharing anything

- Do I need the **value**, or do I need to know that a value **exists** and where it
  is? The second one is almost always enough, and it is always safe.
- If I need the value, does it have to travel at all? Can the machine that holds it
  reach the machine that needs it?
- If it does travel, can the receiving side read it from a path I control, with
  permissions I can check?
- What will the record of this hand over say, and does it hold a secret? A hand over
  whose record is empty is a hand over nobody can audit; a hand over whose record
  holds the value is a hand over nobody should have made.
- When does this copy stop existing, and who destroys it?
