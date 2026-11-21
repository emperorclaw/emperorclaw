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

privacy = obj('PrivacyInfo.xcprivacy', 'PBXFileReference', lastKnownFileType='text.xml', path='PrivacyInfo.xcprivacy', sourceTree='<group>')
file_refs['PrivacyInfo.xcprivacy'] = privacy

assets = obj('Assets.xcassets', 'PBXFileReference', lastKnownFileType='folder.assetcatalog', path='Assets.xcassets', sourceTree='<group>')
file_refs['Assets.xcassets'] = assets

chat_web = obj('ChatWeb', 'PBXFileReference', lastKnownFileType='folder', path='iPhone/ChatWeb', sourceTree='<group>')
file_refs['ChatWeb'] = chat_web

def privacy_resources(name):
    entry = obj(name + 'PrivacyFile', 'PBXBuildFile', fileRef=privacy)
    return obj(name + 'Resources', 'PBXResourcesBuildPhase', buildActionMask='2147483647', files=[entry] + ([obj('ChatWebBuild', 'PBXBuildFile', fileRef=chat_web)] if name == 'EmperorPhone' else []) + ([obj(name + 'AssetsBuild', 'PBXBuildFile', fileRef=assets)] if name in ('EmperorPhone', 'EmperorWatch') else []), runOnlyForDeploymentPostprocessing='0')

package = obj('package', 'XCLocalSwiftPackageReference', relativePath='.')

widget_source = obj('Widgets/FleetWidget.swift', 'PBXFileReference', lastKnownFileType='sourcecode.swift', path='Widgets/FleetWidget.swift', sourceTree='<group>')
file_refs['Widgets/FleetWidget.swift'] = widget_source
widget_targets = {}
for target_name, sdk, deployment, family, bundle in [
    ('PhoneWidgets', 'iphoneos', '17.0', '1,2', 'com.emperorclaw.app.widgets'),
    ('WatchWidgets', 'watchos', '10.0', '4', 'com.emperorclaw.app.watchkitapp.widgets')]:
    product = obj(target_name + '.appex', 'PBXFileReference', explicitFileType='wrapper.app-extension', path=target_name + '.appex', sourceTree='BUILT_PRODUCTS_DIR')
    products.append(product)
    dep = obj(target_name + 'Core', 'XCSwiftPackageProductDependency', package=package, productName='EmperorCore')
    source = obj(target_name + 'SourceFile', 'PBXBuildFile', fileRef=widget_source)
    framework = obj(target_name + 'CoreFile', 'PBXBuildFile', productRef=dep)
    phases = [obj(target_name + 'Sources', 'PBXSourcesBuildPhase', buildActionMask='2147483647', files=[source], runOnlyForDeploymentPostprocessing='0'), obj(target_name + 'Frameworks', 'PBXFrameworksBuildPhase', buildActionMask='2147483647', files=[framework], runOnlyForDeploymentPostprocessing='0')]
    phases.append(privacy_resources(target_name))
    configs = []
    for config in ['Debug', 'Release']:
        settings = {'SDKROOT': sdk, 'SUPPORTED_PLATFORMS': 'watchos watchsimulator' if sdk == 'watchos' else 'iphoneos iphonesimulator', ('WATCHOS_DEPLOYMENT_TARGET' if sdk == 'watchos' else 'IPHONEOS_DEPLOYMENT_TARGET'): deployment, 'TARGETED_DEVICE_FAMILY': family, 'PRODUCT_BUNDLE_IDENTIFIER': bundle, 'PRODUCT_NAME': '$(TARGET_NAME)', 'SWIFT_VERSION': '5.0', 'INFOPLIST_FILE': 'Widgets/Info.plist', 'CODE_SIGN_ENTITLEMENTS': 'Widgets/Widgets.entitlements', 'APPLICATION_EXTENSION_API_ONLY': 'YES', 'SKIP_INSTALL': 'YES', 'CODE_SIGN_STYLE': 'Automatic', 'MARKETING_VERSION': '0.1.0', 'CURRENT_PROJECT_VERSION': '1'}
        configs.append(obj(target_name + config, 'XCBuildConfiguration', buildSettings=settings, name=config))
    config_list = obj(target_name + 'ConfigList', 'XCConfigurationList', buildConfigurations=configs, defaultConfigurationIsVisible='0', defaultConfigurationName='Release')
    target = obj(target_name, 'PBXNativeTarget', buildConfigurationList=config_list, buildPhases=phases, buildRules=[], dependencies=[], name=target_name, packageProductDependencies=[dep], productName=target_name, productReference=product, productType='com.apple.product-type.app-extension')
    targets.append(target); widget_targets[target_name] = (target, product)
# Notification service extension (iPhone): opens end-to-end sealed push content.
nse_source = obj('NotificationService/NotificationService.swift', 'PBXFileReference', lastKnownFileType='sourcecode.swift', path='NotificationService/NotificationService.swift', sourceTree='<group>')
file_refs['NotificationService/NotificationService.swift'] = nse_source
nse_product = obj('NotificationService.appex', 'PBXFileReference', explicitFileType='wrapper.app-extension', path='NotificationService.appex', sourceTree='BUILT_PRODUCTS_DIR')
products.append(nse_product)
nse_dep = obj('NotificationServiceCore', 'XCSwiftPackageProductDependency', package=package, productName='EmperorCore')
nse_phases = [obj('NotificationServiceSources', 'PBXSourcesBuildPhase', buildActionMask='2147483647', files=[obj('NotificationServiceSourceFile', 'PBXBuildFile', fileRef=nse_source)], runOnlyForDeploymentPostprocessing='0'),
              obj('NotificationServiceFrameworks', 'PBXFrameworksBuildPhase', buildActionMask='2147483647', files=[obj('NotificationServiceCoreFile', 'PBXBuildFile', productRef=nse_dep)], runOnlyForDeploymentPostprocessing='0'),
              privacy_resources('NotificationService')]
nse_configs = [obj('NotificationService' + config, 'XCBuildConfiguration', buildSettings={'SDKROOT': 'iphoneos', 'SUPPORTED_PLATFORMS': 'iphoneos iphonesimulator', 'IPHONEOS_DEPLOYMENT_TARGET': '17.0', 'TARGETED_DEVICE_FAMILY': '1,2', 'PRODUCT_BUNDLE_IDENTIFIER': 'com.emperorclaw.app.notifications', 'PRODUCT_NAME': '$(TARGET_NAME)', 'SWIFT_VERSION': '5.0', 'INFOPLIST_FILE': 'NotificationService/Info.plist', 'CODE_SIGN_ENTITLEMENTS': 'NotificationService/NotificationService.entitlements', 'APPLICATION_EXTENSION_API_ONLY': 'YES', 'SKIP_INSTALL': 'YES', 'CODE_SIGN_STYLE': 'Automatic', 'MARKETING_VERSION': '0.1.0', 'CURRENT_PROJECT_VERSION': '1'}, name=config) for config in ['Debug', 'Release']]
nse_config_list = obj('NotificationServiceConfigList', 'XCConfigurationList', buildConfigurations=nse_configs, defaultConfigurationIsVisible='0', defaultConfigurationName='Release')
nse_target = obj('NotificationService', 'PBXNativeTarget', buildConfigurationList=nse_config_list, buildPhases=nse_phases, buildRules=[], dependencies=[], name='NotificationService', packageProductDependencies=[nse_dep], productName='NotificationService', productReference=nse_product, productType='com.apple.product-type.app-extension')
targets.append(nse_target)
(ROOT / 'NotificationService').mkdir(exist_ok=True)
(ROOT / 'NotificationService' / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleDisplayName': 'EmperorClaw', 'CFBundleName': '$(PRODUCT_NAME)', 'CFBundleExecutable': '$(EXECUTABLE_NAME)', 'CFBundleIdentifier': '$(PRODUCT_BUNDLE_IDENTIFIER)', 'CFBundlePackageType': 'XPC!', 'CFBundleShortVersionString': '$(MARKETING_VERSION)', 'CFBundleVersion': '$(CURRENT_PROJECT_VERSION)', 'NSExtension': {'NSExtensionPointIdentifier': 'com.apple.usernotifications.service', 'NSExtensionPrincipalClass': '$(PRODUCT_MODULE_NAME).NotificationService'}}))
(ROOT / 'NotificationService' / 'NotificationService.entitlements').write_bytes(plistlib.dumps({'com.apple.security.application-groups': ['group.com.emperorclaw.app']}))
(ROOT / 'Widgets' / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleDisplayName': 'EmperorClaw', 'CFBundleName': '$(PRODUCT_NAME)', 'CFBundleExecutable': '$(EXECUTABLE_NAME)', 'CFBundleIdentifier': '$(PRODUCT_BUNDLE_IDENTIFIER)', 'CFBundlePackageType': 'XPC!', 'CFBundleShortVersionString': '$(MARKETING_VERSION)', 'CFBundleVersion': '$(CURRENT_PROJECT_VERSION)', 'NSExtension': {'NSExtensionPointIdentifier': 'com.apple.widgetkit-extension'}}))
(ROOT / 'Widgets' / 'Widgets.entitlements').write_bytes(plistlib.dumps({'com.apple.security.application-groups': ['group.com.emperorclaw.app']}))
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
              privacy_resources(name)]
    dependencies = []
    widget_name = 'WatchWidgets' if folder == 'Watch' else 'PhoneWidgets'
    widget_target, widget_product = widget_targets[widget_name]
    widget_embed = obj(name + 'WidgetEmbedFile', 'PBXBuildFile', fileRef=widget_product, settings={'ATTRIBUTES': ['RemoveHeadersOnCopy']})
    phases.append(obj(name + 'WidgetEmbed', 'PBXCopyFilesBuildPhase', buildActionMask='2147483647', dstPath='', dstSubfolderSpec='13', files=[widget_embed], name='Embed Widgets', runOnlyForDeploymentPostprocessing='0'))
    widget_proxy = obj(name + 'WidgetProxy', 'PBXContainerItemProxy', containerPortal=ident('Project'), proxyType='1', remoteGlobalIDString=widget_target, remoteInfo=widget_name)
    dependencies.append(obj(name + 'WidgetDependency', 'PBXTargetDependency', target=widget_target, targetProxy=widget_proxy))
    if name == 'EmperorPhone':
        nse_embed = obj('NotificationServiceEmbedFile', 'PBXBuildFile', fileRef=nse_product, settings={'ATTRIBUTES': ['RemoveHeadersOnCopy']})
        phases.append(obj('NotificationServiceEmbed', 'PBXCopyFilesBuildPhase', buildActionMask='2147483647', dstPath='', dstSubfolderSpec='13', files=[nse_embed], name='Embed Notification Service', runOnlyForDeploymentPostprocessing='0'))
        nse_proxy = obj('NotificationServiceProxy', 'PBXContainerItemProxy', containerPortal=ident('Project'), proxyType='1', remoteGlobalIDString=nse_target, remoteInfo='NotificationService')
        dependencies.append(obj('NotificationServiceDependency', 'PBXTargetDependency', target=nse_target, targetProxy=nse_proxy))
        embed = obj('EmbedWatchBuild', 'PBXBuildFile', fileRef=ident('EmperorWatch.app'), settings={'ATTRIBUTES': ['RemoveHeadersOnCopy']})
        phases.append(obj('EmbedWatch', 'PBXCopyFilesBuildPhase', buildActionMask='2147483647', dstPath='$(CONTENTS_FOLDER_PATH)/Watch', dstSubfolderSpec='16', files=[embed], name='Embed Watch Content', runOnlyForDeploymentPostprocessing='0'))
        proxy = obj('WatchProxy', 'PBXContainerItemProxy', containerPortal=ident('Project'), proxyType='1', remoteGlobalIDString=ident('EmperorWatch'), remoteInfo='EmperorWatch')
        dependencies.append(obj('WatchDependency', 'PBXTargetDependency', target=ident('EmperorWatch'), targetProxy=proxy))
    configs = []
    for config in ['Debug', 'Release']:
        settings = {'SDKROOT': sdk, 'SUPPORTED_PLATFORMS': 'watchos watchsimulator' if folder == 'Watch' else 'iphoneos iphonesimulator',
                    ('WATCHOS_DEPLOYMENT_TARGET' if folder == 'Watch' else 'IPHONEOS_DEPLOYMENT_TARGET'): deployment,
                    'TARGETED_DEVICE_FAMILY': family, 'PRODUCT_BUNDLE_IDENTIFIER': bundle, 'PRODUCT_NAME': '$(TARGET_NAME)',
                    'SWIFT_VERSION': '5.0', 'APS_ENVIRONMENT': 'development' if config == 'Debug' else 'production', 'CODE_SIGN_ENTITLEMENTS': folder + '/App.entitlements', 'INFOPLIST_FILE': folder + '/Info.plist', 'GENERATE_INFOPLIST_FILE': 'NO',
                    'MARKETING_VERSION': '0.1.0', 'CURRENT_PROJECT_VERSION': '1', 'CODE_SIGN_STYLE': 'Automatic',
                    'SWIFT_ACTIVE_COMPILATION_CONDITIONS': 'DEBUG' if config == 'Debug' else '',
                    'ASSETCATALOG_COMPILER_APPICON_NAME': 'AppIcon', 'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME': 'AccentColor', 'SWIFT_OPTIMIZATION_LEVEL': '-Onone' if config == 'Debug' else '-O', 'ENABLE_USER_SCRIPT_SANDBOXING': 'YES'}
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
        info.update({'LSRequiresIPhoneOS': True, 'UILaunchScreen': {'UIColorName': 'LaunchBackground', 'UIImageName': 'LaunchEmblem', 'UIImageRespectsSafeAreaInsets': True}, 'UISupportedInterfaceOrientations': ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
                     'CFBundleURLTypes': [{'CFBundleURLName': 'EmperorClaw sign-in', 'CFBundleURLSchemes': ['com.emperorclaw.app']}]})
    if folder == 'iPhone':
        info.update({'NSMicrophoneUsageDescription': 'Record voice notes for your agents.', 'NSCameraUsageDescription': 'Scan the connection QR code from your own EmperorClaw server.', 'UIBackgroundModes': ['remote-notification']})
    (ROOT / folder / 'App.entitlements').write_bytes(plistlib.dumps({'aps-environment': '$(APS_ENVIRONMENT)', 'com.apple.security.application-groups': ['group.com.emperorclaw.app']}))
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
