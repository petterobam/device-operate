#import <CoreServices/CoreServices.h>
#import <Foundation/Foundation.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static void writeJSON(id value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
}

static NSString *contentTypeForExtension(NSString *extension) {
  UTType *type = [UTType typeWithFilenameExtension:extension];
  return type.identifier;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) {
      writeJSON(@{ @"ok" : @NO, @"error" : @"Missing command" });
      return 2;
    }

    NSString *command = [NSString stringWithUTF8String:argv[1]];
    if ([command isEqualToString:@"get"]) {
      NSMutableArray *types = [NSMutableArray array];
      for (int index = 2; index < argc; index += 1) {
        NSString *extension = [NSString stringWithUTF8String:argv[index]];
        NSString *contentType = contentTypeForExtension(extension);
        if (!contentType) {
          [types addObject:@{ @"extension" : extension, @"uti" : [NSNull null], @"defaultHandler" : [NSNull null], @"handlers" : @[] }];
          continue;
        }

        CFStringRef defaultRef = LSCopyDefaultRoleHandlerForContentType((__bridge CFStringRef)contentType, kLSRolesAll);
        CFArrayRef handlersRef = LSCopyAllRoleHandlersForContentType((__bridge CFStringRef)contentType, kLSRolesAll);
        NSString *defaultHandler = CFBridgingRelease(defaultRef);
        NSArray *handlers = CFBridgingRelease(handlersRef) ?: @[];
        [types addObject:@{
          @"extension" : extension,
          @"uti" : contentType,
          @"defaultHandler" : defaultHandler ?: [NSNull null],
          @"handlers" : handlers
        }];
      }
      writeJSON(@{ @"ok" : @YES, @"types" : types });
      return 0;
    }

    if ([command isEqualToString:@"set"] && argc == 4) {
      NSString *contentType = [NSString stringWithUTF8String:argv[2]];
      NSString *bundleId = [NSString stringWithUTF8String:argv[3]];
      OSStatus status = LSSetDefaultRoleHandlerForContentType(
        (__bridge CFStringRef)contentType,
        kLSRolesAll,
        (__bridge CFStringRef)bundleId
      );
      if (status != noErr) {
        writeJSON(@{ @"ok" : @NO, @"error" : [NSString stringWithFormat:@"Launch Services error %d", (int)status] });
        return 1;
      }
      writeJSON(@{ @"ok" : @YES, @"uti" : contentType, @"bundleId" : bundleId });
      return 0;
    }

    writeJSON(@{ @"ok" : @NO, @"error" : @"Unsupported command" });
    return 2;
  }
}
