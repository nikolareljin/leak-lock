## Create the Extension

Create the new VSCode extension:

```sh
npx --package yo --package generator-code -- yo code
```

Then, select the option:

```
New Extension (JavaScript)
```

Finally, set up required data:

? What's the name of your extension? `leak-lock`
? What's the identifier of your extension? `leak-lock`
? What's the description of your extension? `Developer tools to help engineers stay cybersecure without interrupting their workflows`
? Enable JavaScript type checking in 'jsconfig.json'? `Yes`
? Initialize a git repository? `Yes`
? Which package manager to use? `yarn`

## Install Docker Desktop 

- https://www.docker.com/products/docker-desktop/
- https://docs.docker.com/desktop/setup/install/windows-install/

## Set up Praetorian (Docker)

- Run Praetorian something like:

```sh
path="<current file>"
date_file=$(date '+%Y-%m-%d-%H-%M-%S')
arg="report --datastore np.${path} --format json"
docker run -v "$PWD":/scan ghcr.io/praetorian-inc/noseyparker:latest ${arg} >"scan_${date_file}.json"
```

## Get values from Praetorian, display in VSCode

- display info from the file in the sidebar (GUI)
- Display links to allow easy opening of files
- use Git hash value to allow using github API or git command to checkout specific file
- allow editing the code in-place

## Publish the VSCode Extension

To publish your VSCode extension, follow these steps:

1. **Install `vsce` (Visual Studio Code Extension Manager)**:

```sh
npm install -g vsce
```

2. **Package your extension**:

```sh
vsce package
```

3. **Publish your extension**:

- First, you need to create a publisher if you don't have one:

```sh
vsce create-publisher <publisher-name>
```

- Then, publish your extension:

```sh
vsce publish
```

4. **Update your extension**:

- When you make changes and want to publish a new version, update the version number in `package.json` and run:

```sh
vsce publish
```

Make sure you have a Microsoft account and have logged in to the Visual Studio Code Marketplace before publishing.


# Github Actions for publishing

**Better option:** use Github Actions

Best option: use Github Actions with stored credentials to publish your package to the VS Code Marketplace each time you merge to `master`.

For this, you need to register an account with the Token for publishing the Extension. This variable can be stored into Github Credentials: `VSCE_TOKEN` value in this case. 

Use `main.yml` under `./.github/workflows/` for autiomation.


# Remove unwanted content

Using `bfg` tool (you need to install it), run the commands that will remove the unwanted files or content:


To remove entire files:

```
bfg --delete-files <YOUR-FILE-WITH-SENSITIVE-DATA>
```

To remove some content from the files (such as passwords):

```
bfg --replace-text passwords.txt
```

## Install BFG tool

BFG tool: 
https://rtyley.github.io/bfg-repo-cleaner/

To install BFG tool: 

1. download from: https://repo1.maven.org/maven2/com/madgag/bfg/1.15.0/bfg-1.15.0.jar
2. copy to local, possibly to the `~/bfg/` directory, so that we can access it easily
3. setup BFG alias for simplicity: 

This should create an alias in ZSHRC file. Use BASHRC if not on MacOS / if not using ZSH but using BASH

in the `~/.zshrc` file, add this line:

```
alias bfg='java -jar ~/bfg/bfg-1.15.0.jar'
```

4. test this by running `bfg` in the terminal.


It would be great to achieve this in the background while installing the plugin. 
This would be optional..


## Install JAVA

- https://www.java.com/en/download/


On Mac:

```
brew install java
```
