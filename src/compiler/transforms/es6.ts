/// <reference path="../transform.generated.ts" />
namespace ts.transform {
    export function toES6(context: VisitorContext, statements: NodeArray<Statement>) {
        return transform.visitNodeArrayOfStatement(context, statements, transformNode);
    }
    
    function transformNode(context: VisitorContext, node: Node): Node {
        if (!node) {
            return node;
        }
        
        if (needsTransform(node, TransformFlags.ThisNodeNeedsTransformToES6)) {
            return transformNodeWorker(context, node);
        }
        else if (needsTransform(node, TransformFlags.SubtreeNeedsTransformToES6)) {
            return accept(context, node, transformNode);
        }
        
        return node;
    }
    
    function transformNodeWorker(context: VisitorContext, node: Node): Node {
        // Elide ambient nodes
        if (node.flags & NodeFlags.Ambient) {
            return undefined;
        }
        
        switch (node.kind) {
            case SyntaxKind.PublicKeyword:
            case SyntaxKind.PrivateKeyword:
            case SyntaxKind.ProtectedKeyword:
            case SyntaxKind.AbstractKeyword:
            case SyntaxKind.AsyncKeyword:
            case SyntaxKind.ConstKeyword:
            case SyntaxKind.DeclareKeyword:
                // TypeScript accessibility modifiers are elided
                return undefined;
                
            case SyntaxKind.Decorator:
                // TypeScript decorators are elided. They will be emitted as part of transformClassDeclaration
                return undefined;
                
            case SyntaxKind.InterfaceDeclaration:
            case SyntaxKind.TypeAliasDeclaration:
                // TypeScript type-only declarations are elided
                return undefined;
                
            case SyntaxKind.ClassDeclaration:
                // This is a class declaration with TypeScript syntax extensions.
                // TypeScript class syntax extensions include: Decorators, Parameter Property Assignments, Property Declarations
                return transformClassDeclaration(context, <ClassDeclaration>node);

            case SyntaxKind.ClassExpression:
                // This is a class expression with TypeScript syntax extensions.
                return transformClassExpression(context, <ClassExpression>node);
            
            case SyntaxKind.HeritageClause:
                return transformHeritageClause(context, <HeritageClause>node);
                
            case SyntaxKind.ExpressionWithTypeArguments:
                return transformExpressionWithTypeArguments(context, <ExpressionWithTypeArguments>node);
            
            case SyntaxKind.Constructor:
                // TypeScript repositions the constructor of a class to the first element
                return undefined;
                
            case SyntaxKind.PropertyDeclaration:
                // TypeScript property declarations are elided
                return undefined;
                
            case SyntaxKind.IndexSignature:
                // TypeScript index signatures are elided
                return undefined;
                
            case SyntaxKind.Constructor:
                // TypeScript constructors are elided. The constructor of a class will be
                // reordered to the start of the member list in transformClassDeclaration.
                return undefined;
                
            case SyntaxKind.MethodDeclaration:
                // TypeScript method declarations may be 'async', and may have decorators.
                return transformMethodDeclaration(context, <MethodDeclaration>node);
                
            case SyntaxKind.GetAccessor:
                return transformGetAccessor(context, <GetAccessorDeclaration>node);
                
            case SyntaxKind.SetAccessor:
                return transformSetAccessor(context, <SetAccessorDeclaration>node);
                
            default:
                return transform.accept(context, node, transformNode);
        }
    }
    
    function transformClassDeclaration(context: VisitorContext, node: ClassDeclaration): ClassDeclaration {
        let baseTypeNode = getClassExtendsHeritageClauseElement(node);
        let modifiers = visitNodeArrayOfModifier(context, node.modifiers, transformNodeWorker);
        let heritageClauses = visitNodeArrayOfHeritageClause(context, node.heritageClauses, transformNodeWorker);
        let ctor = transformConstructor(context, node, baseTypeNode !== undefined);
        let members = visitNodeArrayOfClassElement(context, node.members, transformNodeWorker);
        if (ctor) {
            members = factory.createNodeArray([ctor, ...members]);
        }

        if (node.decorators) {
            let newNode = factory.createVariableStatement2(
                <Identifier>context.getDeclarationName(node),
                factory.createClassExpression2(
                    node.name ? context.createUniqueIdentifier(node.name.text) : undefined,
                    heritageClauses ? heritageClauses[0] : undefined,
                    members
                ),
                /*location*/ node,
                NodeFlags.Let
            );
            newNode.original = node;
            context.emitStatement(newNode);
        }
        else {
            let newNode = factory.updateClassDeclaration(
                node,
                /*decorators*/ undefined,
                /*modifiers*/ modifiers,
                node.name,
                /*typeParameters*/ undefined,
                /*heritageClauses*/ heritageClauses,
                /*members*/ members
            );
        }
        
        let staticPropertyAssignments = getInitializedProperties(node, /*isStatic*/ true);
        if (staticPropertyAssignments) {
            emitPropertyDeclarations(context, node, staticPropertyAssignments);
        }

        // Transform any decorators into following statements        
        emitDecoratorsOfClass(context, node);
        return undefined;
    }

    function transformClassExpression(context: VisitorContext, node: ClassExpression): LeftHandSideExpression {
        // TODO(rbuckton): Handle decorators, for now we don't change the class and let the old emitter handle this
        if (node.decorators) {
            return node;
        }

        let baseTypeNode = getClassExtendsHeritageClauseElement(node);
        let modifiers = visitNodeArrayOfModifier(context, node.modifiers, transformNodeWorker);
        let heritageClauses = visitNodeArrayOfHeritageClause(context, node.heritageClauses, transformNodeWorker);
        let ctor = transformConstructor(context, node, baseTypeNode !== undefined);
        let members = visitNodeArrayOfClassElement(context, node.members, transformNodeWorker);
        if (ctor) {
            members = factory.createNodeArray([ctor, ...members]);
        }
        
        let newNode = factory.updateClassExpression(
            node,
            /*decorators*/ undefined,
            /*modifiers*/ modifiers,
            node.name,
            /*typeParameters*/ undefined,
            /*heritageClauses*/ heritageClauses,
            /*members*/ members
        );
        
        let staticPropertyAssignments = getInitializedProperties(node, /*isStatic*/ true);
        if (staticPropertyAssignments) {
            let tempVariable = context.declareLocal();
            return factory.createParenthesizedExpression(
                factory.inlineExpressions([
                    factory.createAssignmentExpression(tempVariable, newNode),
                    ...transformPropertyDeclarations(context, node, staticPropertyAssignments),
                    tempVariable
                ])
            );
        }
        
        return newNode;
    }
    
    function transformConstructor(context: VisitorContext, node: ClassLikeDeclaration, hasBaseType: boolean) {
        // Check if we have a property assignment inside class declaration.
        // If there is a property assignment, we need to emit constructor whether users define it or not
        // If there is no property assignment, we can omit constructor if users do not define it
        let ctor = getFirstConstructorWithBody(node);
        let parameterPropertyAssignments = ctor ? getParametersWithPropertyAssignments(ctor) : undefined;
        let instancePropertyAssignments = getInitializedProperties(node, /*isStatic*/ false);
        let leadingCommentRanges: CommentRange[];
        let trailingCommentRanges: CommentRange[];
        for (let member of node.members) {
            if (isConstructor(member) && !member.body) {
                let leadingCommentRangesOfMember = context.getLeadingCommentRanges(member, /*onlyPinnedOrTripleSlashComments*/ true);
                leadingCommentRanges = concatenate(leadingCommentRanges, leadingCommentRangesOfMember);
            }
        }
        
        // For target ES6 and above, if there is no property assignment
        // do not emit constructor in class declaration.
        if (!parameterPropertyAssignments && !instancePropertyAssignments) {
            if (leadingCommentRanges) {
                leadingCommentRanges = concatenate(leadingCommentRanges, context.getLeadingCommentRanges(ctor));
                ctor = factory.cloneNode(ctor);
                factory.attachCommentRanges(ctor, leadingCommentRanges, trailingCommentRanges);
            }

            return ctor;
        }
        
        context.pushStatements();
        
        let parameters =
            ctor ? visitNodeArrayOfParameter(context, ctor.parameters, transformNode) :
            hasBaseType ? [factory.createRestParameter(factory.createIdentifier("args"))] :
            [];
            
        let superCall: ExpressionStatement;
        if (ctor) {
            leadingCommentRanges = concatenate(
                leadingCommentRanges,
                context.getLeadingCommentRanges(ctor)
            );
            trailingCommentRanges = context.getTrailingCommentRanges(ctor);
            
            if (hasBaseType) {
                superCall = findInitialSuperCall(ctor);
                if (superCall) {
                    context.emitStatement(superCall);
                }
            }
            if (parameterPropertyAssignments) {
                for (let parameter of parameterPropertyAssignments) {
                    context.emitAssignmentStatement(
                        factory.createPropertyAccessExpression2(
                            factory.createThisKeyword(),
                            <Identifier>factory.cloneNode(parameter.name)
                        ),
                        <Identifier>factory.cloneNode(parameter.name)
                    );
                }
            }
        }
        else if (hasBaseType) {
            context.emitExpressionStatement(
                factory.createCallExpression2(
                    factory.createNode<LeftHandSideExpression>(SyntaxKind.SuperKeyword),
                    [
                        factory.createSpreadElementExpression(
                            factory.createIdentifier("args")
                        )
                    ]
                )
            );
        }
        
        if (instancePropertyAssignments) {
            emitPropertyDeclarations(context, node, instancePropertyAssignments);
        }
        
        if (ctor) {
            let bodyStatements = superCall
                ? ctor.body.statements
                : ctor.body.statements.slice(1);
            context.emitStatements(visitNodes(context, bodyStatements, transformNode, visitStatement));
        }
        
        let statements = factory.createNodeArray(
            context.getStatements(), 
            /*location*/ ctor ? ctor.body.statements : undefined);

        let body = ctor 
            ? factory.updateBlock(ctor.body, statements) 
            : factory.createBlock(statements);
        
        context.popStatements();
        
        if (ctor) {
            ctor = factory.updateConstructor(
                ctor,
                /*decorators*/ undefined,
                /*modifiers*/ undefined,
                parameters,
                /*type*/ undefined,
                body
            ); 
        }
        else {
            ctor = factory.createConstructor(
                /*decorators*/ undefined,
                /*modifiers*/ undefined,
                parameters,
                /*type*/ undefined,
                body
            );
        }
        
        factory.attachCommentRanges(ctor, leadingCommentRanges, trailingCommentRanges);
        return ctor;
    }
    
    function transformHeritageClause(context: VisitorContext, node: HeritageClause): Node {
        if (node.token === SyntaxKind.ExtendsKeyword) {
            return factory.updateHeritageClause(
                node,
                visitNodeArrayOfExpressionWithTypeArguments(context, node.types, transformNode)
            );
        }
        
        return undefined;
    }

    function transformExpressionWithTypeArguments(context: VisitorContext, node: ExpressionWithTypeArguments) {
        return factory.updateExpressionWithTypeArguments(
            node,
            node.expression,
            /*typeArguments*/ undefined
        );
    }
    
    // emitter.ts:4091
    function emitPropertyDeclarations(context: VisitorContext, node: ClassLikeDeclaration, properties: PropertyDeclaration[]): void {
        for (let property of properties) {
            let propertyAssignment = transformPropertyDeclaration(context, node, property);
            let propertyStatement = factory.createExpressionStatement(propertyAssignment);
            propertyStatement.original = property;
            context.emitStatement(propertyStatement);
        }
    }
    
    function transformPropertyDeclarations(context: VisitorContext, node: ClassLikeDeclaration, properties: PropertyDeclaration[]): Expression[] {
        let expressions: Expression[] = [];
        for (let property of properties) {
            let propertyAssignment = transformPropertyDeclaration(context, node, property);
            propertyAssignment.original = property;
            expressions.push(propertyAssignment);
        }
        return expressions;
    }
    
    function transformPropertyDeclaration(context: VisitorContext, node: ClassLikeDeclaration, property: PropertyDeclaration): Expression {
        let isStatic = (property.flags & NodeFlags.Static) !== 0;
        let target = isStatic
            ? <Identifier>context.getDeclarationName(node)
            : factory.createThisKeyword();
        
        let name = transformPropertyName(context, property, /*isPerInstance*/ !isStatic);
        return factory.createAssignmentExpression(
            factory.createMemberAccessForPropertyName(target, name, /*location*/ property.name),
            visitExpression(context, property.initializer, transformNode)
        );
    }

    // emitter.ts:4074
    function getInitializedProperties(node: ClassLikeDeclaration, isStatic: boolean): PropertyDeclaration[] {
        let properties: PropertyDeclaration[];
        for (let member of node.members) {
            if (member.kind === SyntaxKind.PropertyDeclaration && isStatic === ((member.flags & NodeFlags.Static) !== 0) && (<PropertyDeclaration>member).initializer) {
                if (!properties) {
                    properties = [];
                }
                
                properties.push(<PropertyDeclaration>member);
            }
        }
        
        return properties;
    }
    
    function getParametersWithPropertyAssignments(node: ConstructorDeclaration): ParameterDeclaration[] {
        let parameters: ParameterDeclaration[];
        for (let parameter of node.parameters) {
            if (isIdentifier(parameter.name) && parameter.flags & NodeFlags.AccessibilityModifier) {
                if (!parameters) {
                    parameters = [];
                }
                
                parameters.push(parameter);
            }
        }
        
        return parameters;
    }
    
    function findInitialSuperCall(ctor: ConstructorDeclaration): ExpressionStatement {
        if (ctor.body) {
            let statement = (<Block>ctor.body).statements[0];
            if (statement && statement.kind === SyntaxKind.ExpressionStatement) {
                let expr = (<ExpressionStatement>statement).expression;
                if (expr && expr.kind === SyntaxKind.CallExpression) {
                    let func = (<CallExpression>expr).expression;
                    if (func && func.kind === SyntaxKind.SuperKeyword) {
                        return <ExpressionStatement>statement;
                    }
                }
            }
        }
    }
    
    function transformMethodDeclaration(context: VisitorContext, node: MethodDeclaration) {
        if (!node.body) {
            let missing = factory.createNode<MethodDeclaration>(SyntaxKind.MissingDeclaration, /*location*/ node);
            missing.original = node;
            return missing;
        }
        
        let modifiers = visitNodeArrayOfModifier(context, node.modifiers, transformNode);
        let name = transformPropertyName(context, node);
        let parameters = visitNodeArrayOfParameter(context, node.parameters, transformNode);
        let body = visitBlock(context, node.body, transformNode);
        return factory.updateMethodDeclaration(
            node,
            /*decorators*/ undefined,
            modifiers,
            name,
            /*typeParameters*/ undefined,
            parameters,
            /*typeNode*/ undefined,
            body
        );
    }
    
    function transformGetAccessor(context: VisitorContext, node: GetAccessorDeclaration) {
        let modifiers = visitNodeArrayOfModifier(context, node.modifiers, transformNode);
        let name = transformPropertyName(context, node);
        let parameters = visitNodeArrayOfParameter(context, node.parameters, transformNode);
        let body = visitBlock(context, node.body, transformNode);
        return factory.updateGetAccessor(
            node,
            /*decorators*/ undefined,
            modifiers,
            name,
            parameters,
            /*typeNode*/ undefined,
            body
        );
    }
    
    function transformSetAccessor(context: VisitorContext, node: SetAccessorDeclaration) {
        let modifiers = visitNodeArrayOfModifier(context, node.modifiers, transformNode);
        let name = transformPropertyName(context, node);
        let parameters = visitNodeArrayOfParameter(context, node.parameters, transformNode);
        let body = visitBlock(context, node.body, transformNode);
        return factory.updateSetAccessor(
            node,
            /*decorators*/ undefined,
            modifiers,
            name,
            parameters,
            /*typeNode*/ undefined,
            body
        );
    }
    
    function getExpressionForPropertyName(context: VisitorContext, container: Declaration): Expression {
        let name = transformPropertyName(context, container);
        if (isComputedPropertyName(name)) {
            return name.expression;
        }
        else if (isStringLiteral(name)) {
            return factory.createStringLiteral(name.text);
        }
    }
    
    function transformPropertyName(context: VisitorContext, container: Declaration, isPerInstance?: boolean): PropertyName {
        let name = context.getDeclarationName(container);
        if (isComputedPropertyName(name)) {
            if (!isPerInstance && context.nodeHasGeneratedName(name)) {
                return factory.createIdentifier(context.getGeneratedNameForNode(name));
            }
            
            let expression = visitExpression(context, name.expression, transformNode);
            if (!isPerInstance && nodeCanBeDecorated(container) && nodeIsDecorated(container)) {
                let generatedName = factory.createIdentifier(context.getGeneratedNameForNode(name));
                context.hoistVariableDeclaration(generatedName);
                expression = factory.createAssignmentExpression(
                    generatedName,
                    expression
                );
            }
            
            return factory.updateComputedPropertyName(
                name,
                expression
            );
        }
        else if (isPropertyName(name)) {
            return name;
        }
        
        Debug.fail("Binding patterns cannot be used as property names.");
    }
    
    function emitDecoratorsOfClass(context: VisitorContext, node: ClassLikeDeclaration) {
        emitDecoratorsOfMembers(context, node, /*isStatic*/ false);
        emitDecoratorsOfMembers(context, node, /*isStatic*/ true);
        emitDecoratorsOfConstructor(context, node);
    }
    
    function emitDecoratorsOfMembers(context: VisitorContext, node: ClassLikeDeclaration, isStatic: boolean) {
        for (let member of node.members) {
            // only emit members in the correct group
            if (isStatic !== ((member.flags & NodeFlags.Static) !== 0)) {
                continue;
            }
            
            // skip members that cannot be decorated (such as the constructor)
            // skip a member if it or any of its parameters are not decorated
            if (!nodeCanBeDecorated(member) || !nodeOrChildIsDecorated(member)) {
                continue;
            }
            
            emitDecoratorsOfMember(context, node, member);
        }
    }
    
    function emitDecoratorsOfConstructor(context: VisitorContext, node: ClassLikeDeclaration) {
        let decorators = node.decorators;
        let constructor = getFirstConstructorWithBody(node);
        let hasDecoratedParameters = constructor && forEach(constructor.parameters, nodeIsDecorated);

        // skip decoration of the constructor if neither it nor its parameters are decorated
        if (!decorators && !hasDecoratedParameters) {
            return;
        }

        // Emit the call to __decorate. Given the class:
        //
        //   @dec
        //   class C {
        //   }
        //
        // The emit for the class is:
        //
        //   C = __decorate([dec], C);
        //
        
        let decoratorExpressions: Expression[] = [];
        if (decorators) {
            for (let decorator of decorators) {
                decoratorExpressions.push(visitExpression(context, decorator.expression, transformNode))
            }
        }
        
        if (constructor) {
            emitDecoratorsOfParameters(context, constructor.parameters, decoratorExpressions);
        }
        
        if (context.compilerOptions.emitDecoratorMetadata) {
            emitSerializedTypeMetadata(context, node, decoratorExpressions);
        }
        
        context.emitAssignmentStatement(
            <Identifier>context.getDeclarationName(node),
            factory.createCallExpression2(
                factory.createIdentifier("__decorate"),
                [
                    factory.createArrayLiteralExpression(decoratorExpressions),
                    <Identifier>context.getDeclarationName(node)
                ]
            )
        );
    }
    
    function emitDecoratorsOfMember(context: VisitorContext, node: ClassLikeDeclaration, member: ClassElement) {
        let decorators: Decorator[];
        let parameters: ParameterDeclaration[];

        // skip an accessor declaration if it is not the first accessor
        if (isAccessor(member) && member.body) {
            let accessors = getAllAccessorDeclarations(node.members, member);
            if (member !== accessors.firstAccessor) {
                return;
            }
            
            // get the decorators from the first accessor with decorators
            decorators = accessors.firstAccessor.decorators;
            if (!decorators && accessors.secondAccessor) {
                decorators = accessors.secondAccessor.decorators;
            }

            // we only decorate parameters of the set accessor
            parameters = accessors.setAccessor 
                ? accessors.setAccessor.parameters
                : undefined;
        }
        else {
            decorators = member.decorators;

            // we only decorate the parameters here if this is a method
            if (isMethodDeclaration(member) && member.body) {
                parameters = member.parameters;
            }
        }
        
        // Emit the call to __decorate. Given the following:
        //
        //   class C {
        //     @dec method(@dec2 x) {}
        //     @dec get accessor() {}
        //     @dec prop;
        //   }
        //
        // The emit for a method is:
        //
        //   Object.defineProperty(C.prototype, "method",
        //       __decorate([
        //           dec,
        //           __param(0, dec2),
        //           __metadata("design:type", Function),
        //           __metadata("design:paramtypes", [Object]),
        //           __metadata("design:returntype", void 0)
        //       ], C.prototype, "method", Object.getOwnPropertyDescriptor(C.prototype, "method")));
        //
        // The emit for an accessor is:
        //
        //   Object.defineProperty(C.prototype, "accessor",
        //       __decorate([
        //           dec
        //       ], C.prototype, "accessor", Object.getOwnPropertyDescriptor(C.prototype, "accessor")));
        //
        // The emit for a property is:
        //
        //   __decorate([
        //       dec
        //   ], C.prototype, "prop");
        //

        let decoratorExpressions: Expression[] = [];
        if (decorators) {
            for (let decorator of decorators) {
                decoratorExpressions.push(visitExpression(context, decorator.expression, transformNode))
            }
        }
        
        if (parameters) {
            emitDecoratorsOfParameters(context, parameters, decoratorExpressions);
        }
        
        if (context.compilerOptions.emitDecoratorMetadata) {
            emitSerializedTypeMetadata(context, node, decoratorExpressions);
        }
        
        let prefix = context.getClassMemberPrefix(node, member);
        let decorateCallArguments: Expression[] = [
            factory.createArrayLiteralExpression(decoratorExpressions),
            prefix,
            getExpressionForPropertyName(context, member)
        ];
        
        let expression: Expression = factory.createCallExpression2(
            factory.createIdentifier("__decorate"),
            decorateCallArguments
        );

        if (!isPropertyDeclaration(member)) {
            decorateCallArguments.push(
                factory.createCallExpression2(
                    factory.createPropertyAccessExpression2(
                        factory.createIdentifier("Object"),
                        factory.createIdentifier("getOwnPropertyDescriptor")
                    ),
                    [
                        prefix, 
                        getExpressionForPropertyName(context, member)
                    ]
                )
            );
            
            expression = factory.createCallExpression2(
                factory.createPropertyAccessExpression2(
                    factory.createIdentifier("Object"),
                    factory.createIdentifier("defineProperty")
                ),
                [
                    prefix, 
                    getExpressionForPropertyName(context, member), 
                    expression
                ]
            );
        }

        context.emitExpressionStatement(expression);
    }
    
    function emitDecoratorsOfParameters(context: VisitorContext, parameters: ParameterDeclaration[], expressions: Expression[]) {
        for (let parameterIndex = 0; parameterIndex < parameters.length; parameterIndex++) {
            let parameter = parameters[parameterIndex];
            if (nodeIsDecorated(parameter)) {
                for (let decorator of parameter.decorators) {
                    expressions.push(
                        factory.createCallExpression2(
                            factory.createIdentifier("__param"),
                            [
                                factory.createNumericLiteral2(parameterIndex),
                                visitExpression(context, decorator.expression, transformNode)
                            ]
                        )
                    );
                }
            }
        }
    }
    
    function emitSerializedTypeMetadata(context: VisitorContext, node: Declaration, expressions: Expression[]) {
        if (shouldEmitTypeMetadata(node)) {
            expressions.push(
                factory.createCallExpression2(
                    factory.createIdentifier("__metadata"),
                    [
                        factory.createStringLiteral("design:type"),
                        // TODO
                    ]
                )
            );
        }
        if (shouldEmitParamTypesMetadata(node)) {
            expressions.push(
                factory.createCallExpression2(
                    factory.createIdentifier("__metadata"),
                    [
                        factory.createStringLiteral("design:paramtypes"),
                        // TODO
                    ]
                )
            );
        }
        if (shouldEmitReturnTypeMetadata(node)) {
            expressions.push(
                factory.createCallExpression2(
                    factory.createIdentifier("__metadata"),
                    [
                        factory.createStringLiteral("design:returntype"),
                        // TODO
                    ]
                )
            );
        }
    }

    function shouldEmitTypeMetadata(node: Declaration): boolean {
        // This method determines whether to emit the "design:type" metadata based on the node's kind.
        // The caller should have already tested whether the node has decorators and whether the emitDecoratorMetadata
        // compiler option is set.
        switch (node.kind) {
            case SyntaxKind.MethodDeclaration:
            case SyntaxKind.GetAccessor:
            case SyntaxKind.SetAccessor:
            case SyntaxKind.PropertyDeclaration:
                return true;
        }

        return false;
    }

    function shouldEmitReturnTypeMetadata(node: Declaration): boolean {
        // This method determines whether to emit the "design:returntype" metadata based on the node's kind.
        // The caller should have already tested whether the node has decorators and whether the emitDecoratorMetadata
        // compiler option is set.
        switch (node.kind) {
            case SyntaxKind.MethodDeclaration:
                return true;
        }
        return false;
    }

    function shouldEmitParamTypesMetadata(node: Declaration): boolean {
        // This method determines whether to emit the "design:paramtypes" metadata based on the node's kind.
        // The caller should have already tested whether the node has decorators and whether the emitDecoratorMetadata
        // compiler option is set.
        switch (node.kind) {
            case SyntaxKind.ClassDeclaration:
            case SyntaxKind.MethodDeclaration:
            case SyntaxKind.SetAccessor:
                return true;
        }
        return false;
    }
}