/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import chalk from 'chalk';
import fs from 'fs-extra';
import {execSync} from 'child_process';
import prompts, {Choice} from 'prompts';
import path from 'path';
import shell from 'shelljs';
import {kebabCase, sortBy} from 'lodash';

const RecommendedTemplate = 'classic';
const TypeScriptTemplateSuffix = '-typescript';

function hasYarn() {
  try {
    execSync('yarnpkg --version', {stdio: 'ignore'});
    return true;
  } catch (e) {
    return false;
  }
}

function isValidGitRepoUrl(gitRepoUrl: string) {
  return ['https://', 'git@'].some((item) => gitRepoUrl.startsWith(item));
}

async function updatePkg(pkgPath: string, obj: Record<string, unknown>) {
  const content = await fs.readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(content);
  const newPkg = Object.assign(pkg, obj);

  await fs.outputFile(pkgPath, JSON.stringify(newPkg, null, 2));
}

function readTemplates(templatesDir: string) {
  const templates = fs
    .readdirSync(templatesDir)
    .filter(
      (d) =>
        !d.startsWith('.') &&
        !d.startsWith('README') &&
        !d.endsWith(TypeScriptTemplateSuffix),
    );

  // Classic should be first in list!
  return sortBy(templates, (t) => t !== RecommendedTemplate);
}

function createTemplateChoices(templates: string[]) {
  function makeNameAndValueChoice(value: string): Choice {
    const title =
      value === RecommendedTemplate ? `${value} (recommended)` : value;
    return {title, value};
  }

  return [
    ...templates.map((template) => makeNameAndValueChoice(template)),
    makeNameAndValueChoice('Git repository'),
  ];
}

export default async function init(
  rootDir: string,
  siteName?: string,
  reqTemplate?: string,
  cliOptions: Partial<{
    useNpm: boolean;
    skipInstall: boolean;
    typescript: boolean;
  }> = {},
): Promise<void> {
  const useYarn = !cliOptions.useNpm ? hasYarn() : false;
  const templatesDir = path.resolve(__dirname, '../templates');
  const templates = readTemplates(templatesDir);
  const hasTS = (templateName: string) =>
    fs.pathExistsSync(
      path.resolve(templatesDir, `${templateName}${TypeScriptTemplateSuffix}`),
    );

  let name = siteName;

  // Prompt if siteName is not passed from CLI.
  if (!name) {
    const prompt = await prompts({
      type: 'text',
      name: 'name',
      message: 'What should we name this site?',
      initial: 'website',
    });
    name = prompt.name;
  }

  if (!name) {
    throw new Error(chalk.red('A website name is required.'));
  }

  const dest = path.resolve(rootDir, name);
  if (fs.existsSync(dest)) {
    throw new Error(`Directory already exists at "${dest}"!`);
  }

  let template = reqTemplate;
  let useTS = cliOptions.typescript;
  // Prompt if template is not provided from CLI.
  if (!template) {
    const templatePrompt = await prompts({
      type: 'select',
      name: 'template',
      message: 'Select a template below...',
      choices: createTemplateChoices(templates),
    });
    template = templatePrompt.template;
    if (template && !useTS && hasTS(template)) {
      const tsPrompt = await prompts({
        type: 'confirm',
        name: 'useTS',
        message:
          'This template is available in TypeScript. Do you want to use the TS variant?',
        initial: false,
      });
      useTS = tsPrompt.useTS;
    }
  }

  // If user choose Git repository, we'll prompt for the url.
  if (template === 'Git repository') {
    const repoPrompt = await prompts({
      type: 'text',
      name: 'gitRepoUrl',
      validate: (url?: string) => {
        if (url && isValidGitRepoUrl(url)) {
          return true;
        }
        return chalk.red(`Invalid repository URL`);
      },
      message:
        'Enter a repository URL from GitHub, Bitbucket, GitLab, or any other public repo.\n(e.g: https://github.com/ownerName/repoName.git)',
    });
    template = repoPrompt.gitRepoUrl;
  }

  console.log();
  console.log(chalk.cyan('Creating new Docusaurus project...'));
  console.log();

  if (template && isValidGitRepoUrl(template)) {
    console.log(`Cloning Git template ${chalk.cyan(template)}...`);
    if (
      shell.exec(`git clone --recursive ${template} ${dest}`, {silent: true})
        .code !== 0
    ) {
      throw new Error(chalk.red(`Cloning Git template ${template} failed!`));
    }
  } else if (template && templates.includes(template)) {
    // Docusaurus templates.
    if (useTS) {
      if (!hasTS(template)) {
        throw new Error(
          `Template ${template} doesn't provide the Typescript variant.`,
        );
      }
      template = `${template}${TypeScriptTemplateSuffix}`;
    }
    try {
      await fs.copy(path.resolve(templatesDir, template), dest, {
        dereference: true,
      });
    } catch (err) {
      console.log(
        `Copying Docusaurus template ${chalk.cyan(template)} failed!`,
      );
      throw err;
    }
  } else {
    throw new Error('Invalid template.');
  }

  // Update package.json info.
  try {
    await updatePkg(path.join(dest, 'package.json'), {
      name: kebabCase(name),
      version: '0.0.0',
      private: true,
    });
  } catch (err) {
    console.log(chalk.red('Failed to update package.json.'));
    throw err;
  }

  // We need to rename the gitignore file to .gitignore
  if (
    !fs.pathExistsSync(path.join(dest, '.gitignore')) &&
    fs.pathExistsSync(path.join(dest, 'gitignore'))
  ) {
    await fs.move(path.join(dest, 'gitignore'), path.join(dest, '.gitignore'));
  }
  if (fs.pathExistsSync(path.join(dest, 'gitignore'))) {
    fs.removeSync(path.join(dest, 'gitignore'));
  }

  const pkgManager = useYarn ? 'yarn' : 'npm';
  if (!cliOptions.skipInstall) {
    console.log(`Installing dependencies with ${chalk.cyan(pkgManager)}...`);

    try {
      shell.exec(
        `cd "${name}" && ${
          // Force coloring the output, because the command is invoked by shelljs, not in the interative shell
          useYarn ? 'FORCE_COLOR=true yarn' : 'npm install --color always'
        }`,
      );
    } catch (err) {
      console.log(chalk.red('Installation failed.'));
      throw err;
    }
  }
  console.log();

  // Display the most elegant way to cd.
  const cdpath =
    path.join(process.cwd(), name) === dest
      ? name
      : path.relative(process.cwd(), name);

  console.log(`
Successfully created "${chalk.cyan(cdpath)}".
Inside that directory, you can run several commands:

  ${chalk.cyan(`${pkgManager} start`)}
    Starts the development server.

  ${chalk.cyan(`${pkgManager} ${useYarn ? '' : 'run '}build`)}
    Bundles your website into static files for production.

  ${chalk.cyan(`${pkgManager} ${useYarn ? '' : 'run '}serve`)}
    Serves the built website locally.

  ${chalk.cyan(`${pkgManager} deploy`)}
    Publishes the website to GitHub pages.

We recommend that you begin by typing:

  ${chalk.cyan('cd')} ${cdpath}
  ${chalk.cyan(`${pkgManager} start`)}

Happy building awesome websites!
`);
}
