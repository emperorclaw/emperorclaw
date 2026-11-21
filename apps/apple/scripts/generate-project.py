#!/usr/bin/env python3
"""Generate the dependency-free Xcode project. Run after adding app sources."""
import hashlib
import plistlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / 'EmperorClaw.xcodeproj'
PROJECT.mkdir(exist_ok=True)
objects = {}

def ident(name):
    return hashlib.sha256(name.encode()).hexdigest()[:24].upper()

def obj(object_name, isa, **fields):
    key = ident(object_name)
    objects[key] = {'isa': isa, **fields}
    return key

def quote(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"'

def render(value, depth=0):
    pad = '\t' * depth
    child = '\t' * (depth + 1)
    if isinstance(value, dict):
        return '{\n' + ''.join(f'{child}{quote(k)} = {render(v, depth + 1)};\n' for k, v in value.items()) + pad + '}'
    if isinstance(value, list):
        return '(\n' + ''.join(f'{child}{render(v, depth + 1)},\n' for v in value) + pad + ')'
    return quote(value)

shared = sorted((ROOT / 'Shared').glob('*.swift'))
targets = []
products = []
file_refs = {}
for path in shared + sorted((ROOT / 'iPhone').glob('*.swift')) + sorted((ROOT / 'Watch').glob('*.swift')):
    relative = str(path.relative_to(ROOT))
    file_refs[relative] = obj(relative, 'PBXFileReference', lastKnownFileType='sourcecode.swift', path=relative, sourceTree='<group>')

package = obj('package', 'XCLocalSwiftPackageReference', relativePath='.')
for name, folder, sdk, deployment, family, bundle in [
    ('EmperorWatch', 'Watch', 'watchos', '10.0', '4', 'com.emperorclaw.app.watchkitapp'),
    ('EmperorPhone', 'iPhone', 'iphoneos', '17.0', '1,2', 'com.emperorclaw.app'),
]:
    product = obj(name + '.app', 'PBXFileReference', explicitFileType='wrapper.application', path=name + '.app', sourceTree='BUILT_PRODUCTS_DIR')
    products.append(product)
    dependency = obj(name + 'Core', 'XCSwiftPackageProductDependency', package=package, productName='EmperorCore')
    framework = obj(name + 'CoreBuild', 'PBXBuildFile', productRef=dependency)
    sources = []
    for path in shared + sorted((ROOT / folder).glob('*.swift')):
        relative = str(path.relative_to(ROOT))
        sources.append(obj(name + relative, 'PBXBuildFile', fileRef=file_refs[relative]))
    phases = [obj(name + 'Sources', 'PBXSourcesBuildPhase', buildActionMask='2147483647', files=sources, runOnlyForDeploymentPostprocessing='0'),
              obj(name + 'Frameworks', 'PBXFrameworksBuildPhase', buildActionMask='2147483647', files=[framework], runOnlyForDeploymentPostprocessing='0'),
              obj(name + 'Resources', 'PBXResourcesBuildPhase', buildActionMask='2147483647', files=[], runOnlyForDeploymentPostprocessing='0')]
    dependencies = []
    if name == 'EmperorPhone':
        embed = obj('EmbedWatchBuild', 'PBXBuildFile', fileRef=ident('EmperorWatch.app'), settings={'ATTRIBUTES': ['RemoveHeadersOnCopy']})
        phases.append(obj('EmbedWatch', 'PBXCopyFilesBuildPhase', buildActionMask='2147483647', dstPath='$(CONTENTS_FOLDER_PATH)/Watch', dstSubfolderSpec='16', files=[embed], name='Embed Watch Content', runOnlyForDeploymentPostprocessing='0'))
        proxy = obj('WatchProxy', 'PBXContainerItemProxy', containerPortal=ident('Project'), proxyType='1', remoteGlobalIDString=ident('EmperorWatch'), remoteInfo='EmperorWatch')
        dependencies.append(obj('WatchDependency', 'PBXTargetDependency', target=ident('EmperorWatch'), targetProxy=proxy))
    configs = []
    for config in ['Debug', 'Release']:
        settings = {'SDKROOT': sdk, 'SUPPORTED_PLATFORMS': 'watchos watchsimulator' if folder == 'Watch' else 'iphoneos iphonesimulator',
                    ('WATCHOS_DEPLOYMENT_TARGET' if folder == 'Watch' else 'IPHONEOS_DEPLOYMENT_TARGET'): deployment,
                    'TARGETED_DEVICE_FAMILY': family, 'PRODUCT_BUNDLE_IDENTIFIER': bundle, 'PRODUCT_NAME': '$(TARGET_NAME)',
                    'SWIFT_VERSION': '5.0', 'INFOPLIST_FILE': folder + '/Info.plist', 'GENERATE_INFOPLIST_FILE': 'NO',
                    'MARKETING_VERSION': '0.1.0', 'CURRENT_PROJECT_VERSION': '1', 'CODE_SIGN_STYLE': 'Automatic',
                    'SWIFT_OPTIMIZATION_LEVEL': '-Onone' if config == 'Debug' else '-O', 'ENABLE_USER_SCRIPT_SANDBOXING': 'YES'}
        configs.append(obj(name + config, 'XCBuildConfiguration', buildSettings=settings, name=config))
    config_list = obj(name + 'ConfigList', 'XCConfigurationList', buildConfigurations=configs, defaultConfigurationIsVisible='0', defaultConfigurationName='Release')
    target = obj(name, 'PBXNativeTarget', buildConfigurationList=config_list, buildPhases=phases, buildRules=[], dependencies=dependencies,
                 name=name, packageProductDependencies=[dependency], productName=name, productReference=product, productType='com.apple.product-type.application')
    targets.append(target)
    info = {'CFBundleDevelopmentRegion': 'en', 'CFBundleDisplayName': 'EmperorClaw', 'CFBundleExecutable': '$(EXECUTABLE_NAME)',
            'CFBundleIdentifier': '$(PRODUCT_BUNDLE_IDENTIFIER)', 'CFBundleInfoDictionaryVersion': '6.0', 'CFBundleName': '$(PRODUCT_NAME)',
            'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': '$(MARKETING_VERSION)', 'CFBundleVersion': '$(CURRENT_PROJECT_VERSION)'}
    if folder == 'Watch':
        info.update({'WKApplication': True, 'WKCompanionAppBundleIdentifier': 'com.emperorclaw.app', 'WKWatchOnly': False})
    else:
        info.update({'LSRequiresIPhoneOS': True, 'UILaunchScreen': {}, 'UISupportedInterfaceOrientations': ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
                     'CFBundleURLTypes': [{'CFBundleURLName': 'EmperorClaw sign-in', 'CFBundleURLSchemes': ['com.emperorclaw.app']}]})
    (ROOT / folder / 'Info.plist').write_bytes(plistlib.dumps(info))
    schemes = PROJECT / 'xcshareddata' / 'xcschemes'
    schemes.mkdir(parents=True, exist_ok=True)
    (schemes / (name + '.xcscheme')).write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="{name}.app" BlueprintName="{name}" ReferencedContainer="container:EmperorClaw.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="{name}.app" BlueprintName="{name}" ReferencedContainer="container:EmperorClaw.xcodeproj"/></BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"/>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')

products_group = obj('Products', 'PBXGroup', children=products, name='Products', sourceTree='<group>')
main = obj('Main', 'PBXGroup', children=list(file_refs.values()) + [products_group], sourceTree='<group>')
project_configs = [obj('Project' + config, 'XCBuildConfiguration', buildSettings={'CLANG_ENABLE_MODULES': 'YES', 'SWIFT_VERSION': '5.0'}, name=config) for config in ['Debug', 'Release']]
config_list = obj('ProjectConfigList', 'XCConfigurationList', buildConfigurations=project_configs, defaultConfigurationIsVisible='0', defaultConfigurationName='Release')
root = obj('Project', 'PBXProject', attributes={'LastUpgradeCheck': '1600', 'BuildIndependentTargetsInParallel': 'YES'}, buildConfigurationList=config_list,
           compatibilityVersion='Xcode 14.0', developmentRegion='en', hasScannedForEncodings='0', knownRegions=['en', 'Base'], mainGroup=main,
           packageReferences=[package], productRefGroup=products_group, projectDirPath='', projectRoot='', targets=targets)
(PROJECT / 'project.pbxproj').write_text('// !$*UTF8*$!\n' + render({'archiveVersion': '1', 'classes': {}, 'objectVersion': '56', 'objects': objects, 'rootObject': root}) + '\n')
print('Generated', PROJECT)
